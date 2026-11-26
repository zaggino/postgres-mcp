import { expect, test } from "vitest";

import {
  SqlBindParams,
  TableAliasVisitor,
} from "../../../src/sql/bind-params.ts";
import { AstNode, parseSql } from "../../../src/sql/pg-ast.ts";
import type { SqlExecutor } from "../../../src/sql/safe-sql.ts";

const noDatabase: SqlExecutor = {
  executeQuery: () => Promise.resolve(null),
};

interface Analysis {
  aliases: Record<string, string>;
  columns: Record<string, string[]>;
  tables: string[];
}

async function analyse(sql: string): Promise<Analysis> {
  const { stmts } = await parseSql(sql);
  const stmt = AstNode.from(stmts[0]?.stmt);
  const aliasVisitor = new TableAliasVisitor();
  aliasVisitor.visit(stmt?.nodes("fromClause"));
  const columns = await new SqlBindParams(noDatabase).extractColumns(sql);
  return {
    tables: [...aliasVisitor.tables].sort(),
    aliases: Object.fromEntries(aliasVisitor.aliases),
    columns: Object.fromEntries(
      [...columns].map(([table, cols]) => [table, [...cols].sort()])
    ),
  };
}

test("a single table with WHERE and ORDER BY collects both columns", async () => {
  await expect(
    analyse("SELECT * FROM users WHERE name = 'Alice' ORDER BY age")
  ).resolves.toEqual({
    tables: ["users"],
    aliases: {},
    columns: { users: ["age", "name"] },
  });
});

test("a JOIN resolves aliases for select, ON and WHERE columns", async () => {
  await expect(
    analyse(`
      SELECT u.name, o.order_date
      FROM users u
      JOIN orders o ON u.id = o.user_id
      WHERE o.status = 'pending'
    `)
  ).resolves.toEqual({
    tables: ["orders", "users"],
    aliases: { u: "users", o: "orders" },
    columns: {
      users: ["id", "name"],
      orders: ["order_date", "status", "user_id"],
    },
  });
});

test("a subquery in FROM is scanned and its alias is treated as a table name", async () => {
  await expect(
    analyse(
      "SELECT s.id FROM (SELECT id, total FROM orders WHERE total > 10) s WHERE s.id > 5"
    )
  ).resolves.toEqual({
    tables: ["orders"],
    aliases: {},
    columns: { s: ["id"], orders: ["id", "total"] },
  });
});

test("GROUP BY, HAVING and an ORDER BY on a select alias collect the underlying column", async () => {
  await expect(
    analyse(
      `SELECT status AS st, count(*) AS n FROM orders
       WHERE amount > 5 GROUP BY status HAVING count(*) > 1 ORDER BY st`
    )
  ).resolves.toEqual({
    tables: ["orders"],
    aliases: {},
    columns: { orders: ["amount", "status"] },
  });
});

test("SELECT * collects no columns", async () => {
  await expect(analyse("SELECT * FROM users")).resolves.toEqual({
    tables: ["users"],
    aliases: {},
    columns: {},
  });
});

test("$n placeholders are ignored and the compared columns are collected", async () => {
  await expect(
    analyse("SELECT id FROM users WHERE id = $1 AND status = $2")
  ).resolves.toEqual({
    tables: ["users"],
    aliases: {},
    columns: { users: ["id", "status"] },
  });
});

function statsDriver(cells: Record<string, unknown>): SqlExecutor {
  return { executeQuery: () => Promise.resolve([{ cells }]) };
}

test("columns inside bare SQL/JSON structs are collected", async () => {
  await expect(
    analyse("SELECT json_value(t.col, '$.a') FROM t WHERE t.id = 1")
  ).resolves.toEqual({
    tables: ["t"],
    aliases: {},
    columns: { t: ["col", "id"] },
  });
});

test("a pg_stats integer beyond 2^53 is bound with every digit", async () => {
  const bind = new SqlBindParams(
    statsDriver({
      data_type: "bigint",
      common_vals: "{1234567890123456789}",
      common_freqs: "{0.5}",
      histogram_bounds: null,
    })
  );
  await expect(
    bind.replaceParameters("SELECT id FROM t WHERE t.id = $1")
  ).resolves.toBe("SELECT id FROM t WHERE t.id = 1234567890123456789");
});

test("a small pg_stats float is bound in Python's exponent notation", async () => {
  const bind = new SqlBindParams(
    statsDriver({
      data_type: "double",
      common_vals: "{0.00002}",
      common_freqs: "{0.5}",
      histogram_bounds: null,
    })
  );
  await expect(
    bind.replaceParameters("SELECT id FROM t WHERE t.price = $1")
  ).resolves.toBe("SELECT id FROM t WHERE t.price = 2e-05");
});

test("a quote in a pg_stats text value cannot end the bound string literal", async () => {
  const bind = new SqlBindParams(
    statsDriver({
      data_type: "text",
      common_vals: "{x'; DROP TABLE t; --}",
      common_freqs: "{0.5}",
      histogram_bounds: null,
    })
  );

  const result = await bind.replaceParameters(
    "SELECT id FROM t WHERE t.name = $1"
  );

  expect(result).toContain("'x''; DROP TABLE t; --'");
  expect((await parseSql(result)).stmts).toHaveLength(1);
});
