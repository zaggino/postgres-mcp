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
  expect(
    await analyse("SELECT * FROM users WHERE name = 'Alice' ORDER BY age")
  ).toEqual({
    tables: ["users"],
    aliases: {},
    columns: { users: ["age", "name"] },
  });
});

test("a JOIN resolves aliases for select, ON and WHERE columns", async () => {
  expect(
    await analyse(`
      SELECT u.name, o.order_date
      FROM users u
      JOIN orders o ON u.id = o.user_id
      WHERE o.status = 'pending'
    `)
  ).toEqual({
    tables: ["orders", "users"],
    aliases: { u: "users", o: "orders" },
    columns: {
      users: ["id", "name"],
      orders: ["order_date", "status", "user_id"],
    },
  });
});

test("a subquery in FROM is scanned and its alias is treated as a table name", async () => {
  expect(
    await analyse(
      "SELECT s.id FROM (SELECT id, total FROM orders WHERE total > 10) s WHERE s.id > 5"
    )
  ).toEqual({
    tables: ["orders"],
    aliases: {},
    columns: { s: ["id"], orders: ["id", "total"] },
  });
});

test("GROUP BY, HAVING and an ORDER BY on a select alias collect the underlying column", async () => {
  expect(
    await analyse(
      `SELECT status AS st, count(*) AS n FROM orders
       WHERE amount > 5 GROUP BY status HAVING count(*) > 1 ORDER BY st`
    )
  ).toEqual({
    tables: ["orders"],
    aliases: {},
    columns: { orders: ["amount", "status"] },
  });
});

test("SELECT * collects no columns", async () => {
  expect(await analyse("SELECT * FROM users")).toEqual({
    tables: ["users"],
    aliases: {},
    columns: {},
  });
});

test("$n placeholders are ignored and the compared columns are collected", async () => {
  expect(
    await analyse("SELECT id FROM users WHERE id = $1 AND status = $2")
  ).toEqual({
    tables: ["users"],
    aliases: {},
    columns: { users: ["id", "status"] },
  });
});
