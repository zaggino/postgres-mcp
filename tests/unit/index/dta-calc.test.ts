import { beforeAll, expect, test, vi } from "vitest";
import { ExplainPlanArtifact } from "../../../src/artifacts.ts";
import {
  ConditionColumnCollector,
  DatabaseTuningAdvisor,
} from "../../../src/index/dta-calc.ts";
import type { QueryWeight } from "../../../src/index/index-opt-base.ts";
import { IndexRecommendation } from "../../../src/index/index-opt-base.ts";
import { ColumnCollector, PgFloat } from "../../../src/sql/bind-params.ts";
import { AstNode, loadParser, parseSql } from "../../../src/sql/pg-ast.ts";
import type { SqlExecutor } from "../../../src/sql/safe-sql.ts";
import type { RowResult } from "../../../src/sql/sql-driver.ts";

const ID_FALLBACK_PATTERN = /id = (?:46|'46')/u;
const STATUS_FALLBACK_PATTERN = /status = (?:'active'|'sample_value')/u;
const BETWEEN_FALLBACK_PATTERN = /between (?:10 and 100|42 and 42)/u;
const PLAN_CHANGE_PATTERN = /sequential scans replaced|new index scans/u;

type Cells = Record<string, unknown>;
type ExecuteQuery = SqlExecutor["executeQuery"];
type QueryHandler = (query: string) => RowResult[] | null;

beforeAll(async () => {
  await loadParser();
});

function rows(...items: Cells[]): RowResult[] {
  return items.map((cells) => ({ cells }));
}

/** A driver answering every query through `handler` (an empty result by default). */
function createDriver(handler: QueryHandler = () => []) {
  const executeQuery = vi.fn<ExecuteQuery>((query) =>
    Promise.resolve(handler(query))
  );
  return { executeQuery };
}

/** Answers the n-th query with the n-th response, and later queries with null. */
function sequential(responses: RowResult[][]): QueryHandler {
  let next = 0;
  return () => {
    const response = responses[next] ?? null;
    next += 1;
    return response;
  };
}

function createAdvisor(driver: SqlExecutor = createDriver()) {
  return new DatabaseTuningAdvisor(driver, {
    budgetMb: 10,
    maxRuntimeSeconds: 60,
  });
}

async function parseStatement(query: string): Promise<AstNode> {
  const { stmts } = await parseSql(query);
  const stmt = AstNode.from(stmts[0]?.stmt);
  if (!stmt) {
    throw new Error(`Cannot parse: ${query}`);
  }
  return stmt;
}

async function queryWeight(query: string): Promise<QueryWeight> {
  return [query, await parseStatement(query), 1.0];
}

function toRecord(
  columns: ReadonlyMap<string, ReadonlySet<string>>
): Record<string, string[]> {
  return Object.fromEntries(
    [...columns].map(([table, cols]) => [table, [...cols].sort()])
  );
}

function tableColumns(indexes: readonly IndexRecommendation[]) {
  return indexes.map((idx) => [idx.table, [...idx.columns]]);
}

test("extract columns of a query without table columns is empty", async () => {
  const dta = createAdvisor();
  const columns = await dta.sqlBindParams.extractColumns("SELECT 1");
  expect(toRecord(columns)).toEqual({});
});

test("extract columns of invalid SQL is empty", async () => {
  const dta = createAdvisor();
  const columns = await dta.sqlBindParams.extractColumns("INVALID SQL");
  expect(toRecord(columns)).toEqual({});
});

test("extract columns of a subquery collects the outer and inner tables", async () => {
  const dta = createAdvisor();
  const query =
    "SELECT * FROM users WHERE id IN (SELECT user_id FROM orders WHERE status = 'pending')";
  const columns = await dta.sqlBindParams.extractColumns(query);
  expect(toRecord(columns)).toEqual({
    users: ["id"],
    orders: ["status", "user_id"],
  });
});

test("an index recommendation exposes its table, columns and definition", () => {
  const idx = new IndexRecommendation("users", ["name", "email"]);
  expect(idx.table).toBe("users");
  expect([...idx.columns]).toEqual(["name", "email"]);
  expect(idx.definition).toBe(
    "CREATE INDEX postgres_mcp_idx_users_name_email_2 ON users USING btree (name, email)"
  );
});

test("index recommendations with the same table and columns have equal definitions", () => {
  const idx1 = new IndexRecommendation("users", ["name"]);
  const idx2 = new IndexRecommendation("users", ["name"]);
  const idx3 = new IndexRecommendation("users", ["email"]);

  expect(idx1.indexDefinition).toEqual(idx2.indexDefinition);
  expect(idx1.indexDefinition).not.toEqual(idx3.indexDefinition);
});

test("extract columns from a simple query", async () => {
  const dta = createAdvisor();
  const columns = await dta.sqlBindParams.extractColumns(
    "SELECT * FROM users WHERE name = 'Alice' ORDER BY age"
  );
  expect(toRecord(columns)).toEqual({ users: ["age", "name"] });
});

test("extract columns from a query with JOINs", async () => {
  const dta = createAdvisor();
  const columns = await dta.sqlBindParams.extractColumns(`
    SELECT u.name, o.order_date
    FROM users u
    JOIN orders o ON u.id = o.user_id
    WHERE o.status = 'pending'
    `);
  expect(toRecord(columns)).toEqual({
    users: ["id", "name"],
    orders: ["order_date", "status", "user_id"],
  });
});

test("generate candidates creates single-column candidates with estimated sizes", async () => {
  const driver = createDriver(
    sequential([
      // information_schema.columns
      rows({
        table_name: "users",
        column_name: "name",
        data_type: "character varying",
        character_maximum_length: 150,
        avg_width: 30,
        potential_long_text: true,
      }),
      // create index users.name
      rows({ indexrelid: 123 }),
      // hypopg_list_indexes
      rows({ index_name: "postgres_mcp_idx_users_name_1", index_size: 81_920 }),
      // hypopg_reset
      [],
    ])
  );
  const dta = createAdvisor(driver);

  const queries = [
    await queryWeight("SELECT * FROM users WHERE name = 'Alice'"),
  ];
  const candidates = await dta.generateCandidates(queries, new Set());

  expect(tableColumns(candidates)).toContainEqual(["users", ["name"]]);
  expect(candidates[0]?.estimatedSizeBytes).toBe(10 * 8192);
});

test("analyze workload recommends indexes for the workload tables", async () => {
  const driver = createDriver((query) => {
    if (query.includes("pg_stat_statements")) {
      return rows({
        queryid: 1,
        query: "SELECT * FROM users WHERE id IN (SELECT user_id FROM orders)",
        calls: 100,
        avg_exec_time: 10.0,
      });
    }
    if (query.includes("EXPLAIN")) {
      // Cost with a hypothetical index, otherwise the current cost
      return rows({
        "QUERY PLAN": [
          {
            Plan: { "Total Cost": query.includes("COSTS TRUE") ? 80.0 : 100.0 },
          },
        ],
      });
    }
    if (query.includes("hypopg_reset")) {
      return null;
    }
    if (query.includes("FROM information_schema.columns c")) {
      return rows({
        table_name: "users",
        column_name: "id",
        data_type: "integer",
        character_maximum_length: null,
        avg_width: 4,
        potential_long_text: false,
      });
    }
    if (query.includes("pg_stats")) {
      return rows({ total_width: 10, total_distinct: 100 });
    }
    if (query.includes("pg_extension")) {
      return rows({ exists: 1 });
    }
    if (
      query.includes("hypopg_disable_index") ||
      query.includes("hypopg_enable_index")
    ) {
      return null;
    }
    if (query.includes("pg_total_relation_size")) {
      return rows({ rel_size: 100_000 });
    }
    if (query.includes("pg_stat_user_tables")) {
      return rows({ last_analyze: "2023-01-01" });
    }
    return null;
  });
  const dta = createAdvisor(driver);

  const session = await dta.analyzeWorkload({
    minCalls: 50,
    minAvgTimeMs: 5.0,
  });

  expect(
    session.recommendations.some((r) => ["users", "orders"].includes(r.table))
  ).toBe(true);
});

test("analyze workload reports a failing database and tolerates invalid SQL", async () => {
  const driver = createDriver();
  driver.executeQuery.mockRejectedValue(new Error("HypoPG not available"));
  const dta = createAdvisor(driver);

  const session = await dta.analyzeWorkload({
    minCalls: 50,
    minAvgTimeMs: 5.0,
  });
  expect(session.error).toContain("HypoPG not available");

  driver.executeQuery.mockResolvedValue(null);
  const columns = await dta.sqlBindParams.extractColumns("INVALID SQL");
  expect(toRecord(columns)).toEqual({});
});

test("index exists compares table, type and columns of existing definitions", () => {
  const dta = createAdvisor();

  const testCases: [string, IndexRecommendation, string, boolean][] = [
    [
      "Exact match",
      new IndexRecommendation("users", ["name"]),
      "CREATE INDEX postgres_mcp_idx_users_name_1 ON users USING btree (name)",
      true,
    ],
    [
      "Primary key detection",
      new IndexRecommendation("users", ["id"]),
      "CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)",
      true,
    ],
    [
      "Schema-qualified match",
      new IndexRecommendation("users", ["email"]),
      "CREATE UNIQUE INDEX users_email_key ON public.users USING btree (email)",
      true,
    ],
    [
      "Hash index with different column order",
      new IndexRecommendation("orders", ["customer_id", "product_id"], "hash"),
      "CREATE INDEX orders_idx ON orders USING hash (product_id, customer_id)",
      true,
    ],
    [
      "Partial coverage - not enough",
      new IndexRecommendation("products", ["category", "name", "price"]),
      "CREATE INDEX products_category_idx ON products USING btree (category)",
      false,
    ],
    [
      "Different index type",
      new IndexRecommendation("payments", ["method", "status"], "hash"),
      "CREATE INDEX payments_method_status_idx ON payments USING btree (method, status)",
      false,
    ],
    [
      "Different table",
      new IndexRecommendation("customers", ["id"]),
      "CREATE INDEX users_id_idx ON users USING btree (id)",
      false,
    ],
    [
      "Expression index vs regular column",
      new IndexRecommendation("users", ["name"]),
      "CREATE INDEX users_name_idx ON users USING btree (lower(name))",
      false,
    ],
  ];

  const results = testCases.map(([description, candidate, existingDef]) => [
    description,
    dta.indexExists(candidate, new Set([existingDef])),
  ]);
  expect(results).toEqual(
    testCases.map(([description, , , expected]) => [description, expected])
  );

  // A definition the parser rejects raises, whether or not it would match
  const existing = new Set([
    "CREATE INDEX users_name_email_idx ON users USING btree (name, email)",
  ]);
  expect(() =>
    dta.indexExists(new IndexRecommendation("users", ["name", "("]), existing)
  ).toThrow("Error in robust index comparison");
  expect(() =>
    dta.indexExists(
      new IndexRecommendation("users", ["address", "("]),
      existing
    )
  ).toThrow("Error in robust index comparison");
});

test("index size estimation handles positive, negative and zero ndistinct", () => {
  const dta = createAdvisor();

  expect(
    dta.estimateIndexSizeInternal({ total_width: 10.0, total_distinct: 5 })
  ).toBe(180); // 18.0 * 5.0 * 2.0
  expect(
    dta.estimateIndexSizeInternal({ total_width: 10.0, total_distinct: -0.5 })
  ).toBe(36); // 18.0 * 1.0 * 2.0
  expect(
    dta.estimateIndexSizeInternal({ total_width: 10.0, total_distinct: 0 })
  ).toBe(36); // 18.0 * 1.0 * 2.0
});

test("filter long text columns drops candidates containing long text columns", async () => {
  const typeQueryResults = rows(
    {
      table_name: "users",
      column_name: "name",
      data_type: "character varying",
      character_maximum_length: 50, // Short varchar - keep
      avg_width: 4,
      potential_long_text: false,
    },
    {
      table_name: "users",
      column_name: "bio",
      data_type: "text", // Text type - needs length check
      character_maximum_length: null,
      avg_width: 105,
      potential_long_text: true,
    },
    {
      table_name: "users",
      column_name: "description",
      data_type: "character varying",
      character_maximum_length: 200, // Long varchar - filter out
      avg_width: 70,
      potential_long_text: true,
    },
    {
      table_name: "users",
      column_name: "status",
      data_type: "character varying",
      character_maximum_length: null, // Unlimited varchar - needs length check
      avg_width: 10,
      potential_long_text: true,
    }
  );
  const driver = createDriver((query) =>
    query.includes("information_schema.columns") ? typeQueryResults : null
  );
  const dta = createAdvisor(driver);

  const candidates = [
    new IndexRecommendation("users", ["name"]), // keep (short varchar)
    new IndexRecommendation("users", ["bio"]), // filter out (long text)
    new IndexRecommendation("users", ["description"]), // filter out (long varchar)
    new IndexRecommendation("users", ["status"]), // keep (unlimited varchar, short actual length)
    new IndexRecommendation("users", ["name", "status"]), // keep
    new IndexRecommendation("users", ["name", "bio"]), // filter out (long text)
    new IndexRecommendation("users", ["description", "status"]), // filter out
  ];

  const filtered = await dta.filterLongTextColumns(candidates, 100);

  expect(tableColumns(filtered)).toEqual([
    ["users", ["name"]],
    ["users", ["status"]],
    ["users", ["name", "status"]],
  ]);
});

test("basic workload analysis recommends indexes for the queried columns", async () => {
  const dta = new DatabaseTuningAdvisor(
    createDriver(
      sequential([
        // check if hypopg is enabled
        rows({ hypopg_enabled_result: 1 }),
        // check last analyze
        rows({ last_analyze: "2024-01-01 00:00:00" }),
        // pg_stat_statements
        rows(
          {
            queryid: 1,
            query: "SELECT * FROM users WHERE name = 'Alice'",
            calls: 100,
            avg_exec_time: 10.0,
          },
          {
            queryid: 2,
            query: "SELECT * FROM orders WHERE user_id = 123",
            calls: 50,
            avg_exec_time: 5.0,
          }
        ),
        // pg_indexes
        [],
        // information_schema.columns
        rows(
          {
            table_name: "users",
            column_name: "name",
            data_type: "character varying",
            character_maximum_length: 150,
            avg_width: 30,
            potential_long_text: true,
          },
          {
            table_name: "orders",
            column_name: "user_id",
            data_type: "integer",
            character_maximum_length: null,
            avg_width: 4,
            potential_long_text: false,
          }
        ),
        // hypopg_create_index (for users.name, orders.user_id)
        rows({ indexrelid: 1554 }, { indexrelid: 1555 }),
        // hypopg_list_indexes
        rows(
          { index_name: "postgres_mcp_idx_users_name_1", index_size: 8000 },
          { index_name: "postgres_mcp_idx_orders_user_id_1", index_size: 4000 }
        ),
        // hypopg_reset
        [],
        // EXPLAIN without indexes
        rows({ "QUERY PLAN": [{ Plan: { "Total Cost": 100.0 } }] }), // users.name
        rows({ "QUERY PLAN": [{ Plan: { "Total Cost": 150.0 } }] }), // orders.user_id
        rows({ rel_size: 10_000 }), // users table size
        rows({ rel_size: 10_000 }), // orders table size
        // pg_stats for size (users.name, orders.user_id)
        rows({ total_width: 10, total_distinct: 100 }),
        // EXPLAIN with users.name index
        rows({ "QUERY PLAN": [{ Plan: { "Total Cost": 50.0 } }] }), // users.name
        rows({ "QUERY PLAN": [{ Plan: { "Total Cost": 150.0 } }] }), // orders.user_id
        rows({ total_width: 8, total_distinct: 50 }),
        // EXPLAIN without orders.user_id index
        rows({ "QUERY PLAN": [{ Plan: { "Total Cost": 100.0 } }] }), // users.name
        rows({ "QUERY PLAN": [{ Plan: { "Total Cost": 75.0 } }] }), // orders.user_id
        // EXPLAIN with users.name and orders.user_id indexes
        rows({ "QUERY PLAN": [{ Plan: { "Total Cost": 50.0 } }] }), // users.name
        rows({ "QUERY PLAN": [{ Plan: { "Total Cost": 75.0 } }] }), // orders.user_id
        // hypopg_reset (final cleanup)
        [],
      ])
    ),
    {
      budgetMb: 50,
      maxRuntimeSeconds: 300,
      maxIndexWidth: 2,
      seedColumnsCount: 2,
    }
  );

  const session = await dta.analyzeWorkload({
    minCalls: 50,
    minAvgTimeMs: 5.0,
  });

  expect(session.recommendations.length).toBeGreaterThan(0);
  expect(
    session.recommendations.some(
      (r) => r.table === "users" && r.columns.includes("name")
    )
  ).toBe(true);
  expect(
    session.recommendations.some(
      (r) => r.table === "orders" && r.columns.includes("user_id")
    )
  ).toBe(true);
});

test("replace parameters binds a string column to its most common value", async () => {
  const bind = createAdvisor().sqlBindParams;
  vi.spyOn(bind, "extractColumns").mockResolvedValue(
    new Map([["users", new Set(["name", "id", "status"])]])
  );
  const identify = vi
    .spyOn(bind, "identifyParameterColumn")
    .mockReturnValue(["users", "name"]);
  vi.spyOn(bind, "getColumnStatistics").mockResolvedValue({
    data_type: "character varying",
    common_vals: ["John", "Alice"],
    histogram_bounds: null,
  });

  const result = await bind.replaceParameters(
    "SELECT * FROM users WHERE name = $1".toLowerCase()
  );

  expect(result).toBe("select * from users where name = 'John'");
  expect(identify).toHaveBeenCalledOnce();
});

test("replace parameters binds a numeric column by range or equality", async () => {
  const bind = createAdvisor().sqlBindParams;
  vi.spyOn(bind, "extractColumns").mockResolvedValue(
    new Map([["orders", new Set(["id", "amount", "user_id"])]])
  );
  vi.spyOn(bind, "identifyParameterColumn").mockReturnValue([
    "orders",
    "amount",
  ]);
  vi.spyOn(bind, "getColumnStatistics").mockResolvedValue({
    data_type: "numeric",
    common_vals: [99.99, 49.99],
    histogram_bounds: [
      new PgFloat(10),
      new PgFloat(50),
      new PgFloat(100),
      new PgFloat(500),
    ],
  });

  const range = await bind.replaceParameters(
    "SELECT * FROM orders WHERE amount > $1".toLowerCase()
  );
  const equality = await bind.replaceParameters(
    "SELECT * FROM orders WHERE amount = $1".toLowerCase()
  );

  expect(range).toBe("select * from orders where amount > 100.0");
  expect(equality).toBe("select * from orders where amount = 99.99");
});

test("replace parameters binds a date column to a date literal", async () => {
  const bind = createAdvisor().sqlBindParams;
  vi.spyOn(bind, "extractColumns").mockResolvedValue(
    new Map([["orders", new Set(["id", "order_date", "user_id"])]])
  );
  vi.spyOn(bind, "identifyParameterColumn").mockReturnValue([
    "orders",
    "order_date",
  ]);
  vi.spyOn(bind, "getColumnStatistics").mockResolvedValue({
    data_type: "timestamp without time zone",
    common_vals: null,
    histogram_bounds: null,
  });

  const result = await bind.replaceParameters(
    "SELECT * FROM orders WHERE order_date > $1".toLowerCase()
  );

  expect(result).toBe("select * from orders where order_date > '2023-01-15'");
});

test("replace parameters binds a LIKE parameter to a LIKE pattern", async () => {
  const bind = createAdvisor().sqlBindParams;
  vi.spyOn(bind, "extractColumns").mockResolvedValue(
    new Map([["users", new Set(["name", "email"])]])
  );
  vi.spyOn(bind, "identifyParameterColumn").mockReturnValue(["users", "name"]);
  vi.spyOn(bind, "getColumnStatistics").mockResolvedValue({
    data_type: "character varying",
    common_vals: ["John", "Alice"],
    histogram_bounds: null,
  });

  const result = await bind.replaceParameters(
    "SELECT * FROM users WHERE name LIKE $1".toLowerCase()
  );

  expect(result).toBe("select * from users where name like '%test%'");
});

test("replace parameters binds several parameters of a complex query by column", async () => {
  const bind = createAdvisor().sqlBindParams;
  vi.spyOn(bind, "extractColumns").mockResolvedValue(
    new Map([
      ["users", new Set(["id", "name", "status"])],
      ["orders", new Set(["id", "user_id", "amount", "order_date"])],
    ])
  );
  vi.spyOn(bind, "identifyParameterColumn").mockImplementation((context) => {
    if (context.includes("status =")) {
      return ["users", "status"];
    }
    if (context.includes("amount BETWEEN")) {
      return ["orders", "amount"];
    }
    if (context.includes("order_date >")) {
      return ["orders", "order_date"];
    }
  });
  vi.spyOn(bind, "getColumnStatistics").mockImplementation((table, column) => {
    if (table === "users" && column === "status") {
      return Promise.resolve({
        data_type: "character varying",
        common_vals: ["active", "inactive"],
      });
    }
    if (table === "orders" && column === "amount") {
      return Promise.resolve({
        data_type: "numeric",
        common_vals: [99.99],
        histogram_bounds: [new PgFloat(10), new PgFloat(50), new PgFloat(100)],
      });
    }
    if (table === "orders" && column === "order_date") {
      return Promise.resolve({ data_type: "timestamp without time zone" });
    }
    return Promise.resolve(null);
  });

  const query = `
    SELECT u.name, o.amount
    FROM users u
    JOIN orders o ON u.id = o.user_id
    WHERE u.status = $1
    AND o.amount BETWEEN $2 AND $3
    AND o.order_date > $4
    `;
  const result = await bind.replaceParameters(query.toLowerCase());

  expect(result).toContain("u.status = 'active'");
  expect(result).toContain("o.amount between 10.0 and 100.0");
  expect(result).toContain("o.order_date > '2023-01-15'");
});

test("replace parameters falls back to generic values when no column information is available", async () => {
  const bind = createAdvisor().sqlBindParams;
  vi.spyOn(bind, "extractColumns").mockResolvedValue(new Map());

  const simple = await bind.replaceParameters(
    "SELECT * FROM users WHERE id = $1".toLowerCase()
  );
  expect(simple).toMatch(ID_FALLBACK_PATTERN);

  const complex = await bind.replaceParameters(
    `
    SELECT * FROM users
    WHERE status = $1
    AND created_at > $2
    AND name LIKE $3
    AND age BETWEEN $4 AND $5
    `.toLowerCase()
  );
  expect(complex).toMatch(STATUS_FALLBACK_PATTERN);
  expect(complex).toContain("created_at > '2023-01-01'");
  expect(complex).toContain("name like '%");
  expect(complex).toMatch(BETWEEN_FALLBACK_PATTERN);
});

test("extract columns returns the columns of the tables a query filters on", async () => {
  const bind = createAdvisor().sqlBindParams;

  const result = await bind.extractColumns(
    "SELECT * FROM users WHERE name = $1 AND status = $2"
  );

  expect(toRecord(result)).toEqual({ users: ["name", "status"] });
});

test("identify parameter column finds the column compared with a parameter", () => {
  const bind = createAdvisor().sqlBindParams;
  const columns = new Map([
    ["users", ["id", "name", "status", "email"]],
    ["orders", ["id", "user_id", "amount", "order_date"]],
  ]);

  expect(
    bind.identifyParameterColumn("SELECT * FROM users WHERE name = $1", columns)
  ).toEqual(["users", "name"]);
  expect(
    bind.identifyParameterColumn(
      "SELECT * FROM users WHERE email LIKE $1",
      columns
    )
  ).toEqual(["users", "email"]);
  expect(
    bind.identifyParameterColumn(
      "SELECT * FROM orders WHERE amount > $1",
      columns
    )
  ).toEqual(["orders", "amount"]);
  expect(
    bind.identifyParameterColumn(
      "SELECT * FROM orders WHERE order_date BETWEEN $1 AND $2",
      columns
    )
  ).toEqual(["orders", "order_date"]);
  expect(
    bind.identifyParameterColumn("SELECT * FROM users WHERE $1", columns)
  ).toBeUndefined();
});

test("get replacement value depends on the column type and operator", () => {
  const bind = createAdvisor().sqlBindParams;

  expect(
    bind.getReplacementValue(
      {
        data_type: "character varying",
        common_vals: ["active", "pending", "completed"],
        histogram_bounds: null,
      },
      "status = $1"
    )
  ).toBe("'active'");
  expect(
    bind.getReplacementValue(
      {
        data_type: "numeric",
        common_vals: [new PgFloat(10), new PgFloat(20)],
        histogram_bounds: [
          new PgFloat(5),
          new PgFloat(15),
          new PgFloat(25),
          new PgFloat(50),
          new PgFloat(100),
        ],
      },
      "amount > $1"
    )
  ).toBe("25.0");
  expect(
    bind.getReplacementValue(
      { data_type: "date", common_vals: null, histogram_bounds: null },
      "created_at < $1"
    )
  ).toBe("'2023-01-15'");
  expect(
    bind.getReplacementValue(
      {
        data_type: "boolean",
        common_vals: [true, false],
        histogram_bounds: null,
      },
      "is_active = $1"
    )
  ).toBe("true");
});

test("condition column collector keeps only the columns used in conditions", async () => {
  const parsed = await parseStatement(
    "SELECT hobby FROM users WHERE name = 'Alice' AND age > 25"
  );

  const collector = new ColumnCollector();
  collector.visit(parsed);
  expect(toRecord(collector.columns)).toEqual({
    users: ["age", "hobby", "name"],
  });

  const conditions = new ConditionColumnCollector();
  conditions.visit(parsed);
  expect(toRecord(conditions.conditionColumns)).toEqual({
    users: ["age", "name"],
  });
});

test("condition column collector includes JOIN condition columns", async () => {
  const parsed = await parseStatement(`
    SELECT u.name, o.order_date
    FROM users u
    JOIN orders o ON u.id = o.user_id
    WHERE o.status = 'pending' AND u.active = true
    `);

  const collector = new ColumnCollector();
  collector.visit(parsed);
  expect(toRecord(collector.columns)).toEqual({
    users: ["active", "id", "name"],
    orders: ["order_date", "status", "user_id"],
  });

  const conditions = new ConditionColumnCollector();
  conditions.visit(parsed);
  expect(toRecord(conditions.conditionColumns)).toEqual({
    users: ["active", "id"],
    orders: ["status", "user_id"],
  });
});

test("condition column collector resolves column aliases in conditions", async () => {
  const parsed = await parseStatement(`
    SELECT u.name, u.age, COUNT(o.id) as order_count , o.order_date as begin_order_date, o.status as order_status
    FROM users u
    LEFT JOIN orders o ON u.id = o.user_id
    WHERE u.status = 'active'
    GROUP BY u.name
    HAVING order_count > 5
    ORDER BY order_count DESC
    `);

  const conditions = new ConditionColumnCollector();
  conditions.visit(parsed);

  // o.id comes from HAVING COUNT(o.id) > 5; order_count itself is no column
  expect(toRecord(conditions.conditionColumns)).toEqual({
    users: ["id", "status"],
    orders: ["id", "user_id"],
  });
  expect(conditions.conditionAliases.has("order_count")).toBe(true);

  const collector = new ColumnCollector();
  collector.visit(parsed);
  expect(toRecord(collector.columns)).toEqual({
    users: ["age", "id", "name", "status"],
    orders: ["id", "order_date", "status", "user_id"],
  });
});

test("a complex query with aliases in several conditions collects the underlying columns", async () => {
  const parsed = await parseStatement(`
    SELECT
        u.name,
        u.email,
        EXTRACT(YEAR FROM u.created_at) as join_year,
        COUNT(o.id) as order_count,
        SUM(o.total) as revenue
    FROM users u
    LEFT JOIN orders o ON u.id = o.user_id
    WHERE u.status = 'active' AND join_year > 2020
    GROUP BY u.name, u.email, join_year
    HAVING order_count > 10 AND revenue > 1000
    ORDER BY revenue DESC
    `);

  const collector = new ColumnCollector();
  collector.visit(parsed);
  expect(toRecord(collector.columns)).toEqual({
    users: ["created_at", "email", "id", "name", "status"],
    orders: ["id", "total", "user_id"],
  });

  const conditions = new ConditionColumnCollector();
  conditions.visit(parsed);
  expect(toRecord(conditions.conditionColumns)).toEqual({
    users: ["created_at", "id", "status"],
    orders: ["id", "total", "user_id"],
  });
  expect(conditions.conditionAliases.has("join_year")).toBe(true);
  expect(conditions.conditionAliases.has("order_count")).toBe(true);
  expect(conditions.conditionAliases.has("revenue")).toBe(true);
});

test("filter candidates by query conditions drops candidates with unused columns", async () => {
  const dta = createAdvisor();
  const queries = [
    await queryWeight("SELECT * FROM users WHERE name = 'Alice' AND age > 25"),
    await queryWeight(
      "SELECT * FROM orders WHERE status = 'pending' AND total > 100"
    ),
  ];
  const candidates = [
    new IndexRecommendation("users", ["name"]),
    new IndexRecommendation("users", ["name", "email"]), // email not in conditions
    new IndexRecommendation("users", ["age"]),
    new IndexRecommendation("orders", ["status", "total"]),
    new IndexRecommendation("orders", ["order_date"]), // order_date not in conditions
  ];

  const filtered = dta.filterCandidatesByQueryConditions(queries, candidates);

  expect(tableColumns(filtered)).toEqual([
    ["users", ["name"]],
    ["users", ["age"]],
    ["orders", ["status", "total"]],
  ]);
});

test("condition columns of a comma join are attributed to their tables", async () => {
  const parsed = await parseStatement(`
    SELECT u.name, o.order_date
    FROM users u, orders o
    WHERE o.status = 'pending' AND u.active = true
    `);

  const collector = new ConditionColumnCollector();
  collector.visit(parsed);

  expect(toRecord(collector.conditionColumns)).toEqual({
    users: ["active"],
    orders: ["status"],
  });
});

test("condition collector includes ORDER BY columns", async () => {
  const parsed = await parseStatement(`
    SELECT u.name, o.order_date, o.amount
    FROM orders o
    JOIN users u ON o.user_id = u.id
    WHERE o.status = 'completed'
    ORDER BY o.order_date DESC
    `);

  const collector = new ConditionColumnCollector();
  collector.visit(parsed);

  expect(toRecord(collector.conditionColumns)).toEqual({
    users: ["id"],
    orders: ["order_date", "status", "user_id"],
  });
});

test("condition collector resolves an ORDER BY on a column alias", async () => {
  const parsed = await parseStatement(`
    SELECT u.name, COUNT(o.id) as order_count
    FROM users u
    LEFT JOIN orders o ON u.id = o.user_id
    WHERE u.status = 'active'
    GROUP BY u.name
    ORDER BY order_count DESC
    `);

  const collector = new ConditionColumnCollector();
  collector.visit(parsed);

  // o.id comes from ORDER BY order_count, which is COUNT(o.id)
  expect(toRecord(collector.conditionColumns)).toEqual({
    users: ["id", "status"],
    orders: ["id", "user_id"],
  });
});

test("greedy enumeration stops at the minimum time improvement", async () => {
  const dta = new DatabaseTuningAdvisor(createDriver(), {
    budgetMb: 1000,
    maxRuntimeSeconds: 120,
  });
  vi.spyOn(dta, "checkTime").mockReturnValue(false);

  const queries = [
    await queryWeight("SELECT * FROM test_table WHERE col1 = 1"),
  ];
  const candidateIndexes = new Set<IndexRecommendation>();
  for (let i = 0; i < 10; i += 1) {
    candidateIndexes.add(new IndexRecommendation("test_table", [`col${i}`]));
  }
  const baseCost = 1000.0;

  // Workload cost by the number of indexes in the configuration
  const configCosts = [1000, 700, 560, 504, 479, 474, 469, 464, 459, 454, 449];
  const MB = 1024 * 1024;
  const indexSizes = [1, 2, 2, 8, 16, 32, 32, 32, 32, 32].map((mb) => mb * MB);
  const baseRelationSize = 50 * MB;

  vi.spyOn(dta, "evaluateConfigurationCost").mockImplementation(
    (_queries, config) => Promise.resolve(configCosts[config.length] ?? 0)
  );
  vi.spyOn(dta, "estimateIndexSize").mockImplementation((_table, columns) => {
    const [column = ""] = columns;
    return Promise.resolve(indexSizes[Number(column.slice(3))] ?? MB);
  });
  vi.spyOn(dta, "estimateTableSize").mockResolvedValue(baseRelationSize);

  dta.paretoAlpha = 2.0;

  // 5% threshold: stops after 3 indexes
  dta.minTimeImprovement = 0.05;
  const [finalIndexes, finalCost] = await dta.enumerateGreedy(
    queries,
    new Set(),
    baseCost,
    new Set(candidateIndexes)
  );
  expect(finalIndexes.size).toBe(3);
  expect(finalCost).toBe(504);

  // A lower threshold includes more indexes
  dta.minTimeImprovement = 0.015;
  const [lowerThresholdIndexes] = await dta.enumerateGreedy(
    queries,
    new Set(),
    baseCost,
    new Set(candidateIndexes)
  );
  expect(lowerThresholdIndexes.size).toBeGreaterThanOrEqual(3);

  // A higher threshold includes only the first index
  dta.minTimeImprovement = 0.25;
  const [higherThresholdIndexes] = await dta.enumerateGreedy(
    queries,
    new Set(),
    baseCost,
    new Set(candidateIndexes)
  );
  expect(higherThresholdIndexes.size).toBe(1);
});

test("explain plan diff reports the change from a sequential to an index scan", () => {
  const beforePlan = {
    Plan: {
      "Node Type": "Aggregate",
      Strategy: "Plain",
      "Startup Cost": 300_329.67,
      "Total Cost": 300_329.68,
      "Plan Rows": 1,
      "Plan Width": 32,
      Plans: [
        {
          "Node Type": "Seq Scan",
          "Relation Name": "users",
          Alias: "users",
          "Startup Cost": 0.0,
          "Total Cost": 286_022.64,
          "Plan Rows": 1280,
          "Plan Width": 32,
          Filter: "email LIKE '%example.com'",
        },
      ],
    },
  };
  const afterPlan = {
    Plan: {
      "Node Type": "Aggregate",
      Strategy: "Plain",
      "Startup Cost": 17_212.28,
      "Total Cost": 17_212.29,
      "Plan Rows": 1,
      "Plan Width": 32,
      Plans: [
        {
          "Node Type": "Index Scan",
          "Relation Name": "users",
          Alias: "users",
          "Index Name": "users_email_idx",
          "Startup Cost": 0.43,
          "Total Cost": 17_212.0,
          "Plan Rows": 1280,
          "Plan Width": 32,
          Filter: "email LIKE '%example.com'",
        },
      ],
    },
  };

  const diffOutput = ExplainPlanArtifact.createPlanDiff(beforePlan, afterPlan);

  expect(diffOutput).toContain("PLAN CHANGES:");
  expect(diffOutput).toContain("Cost:");
  expect(diffOutput).toContain("improvement");
  expect(diffOutput).toContain("Seq Scan");
  expect(diffOutput).toContain("Index Scan");
  expect(diffOutput).toContain("→");
  expect(diffOutput).toContain("300329");
  expect(diffOutput).toContain("17212");
  expect(diffOutput).toMatch(PLAN_CHANGE_PATTERN);

  expect(ExplainPlanArtifact.createPlanDiff({}, {})).toContain(
    "Cannot generate diff"
  );
  expect(
    ExplainPlanArtifact.createPlanDiff({ NotAPlan: {} }, { NotAPlan: {} })
  ).toContain("Cannot generate diff");
});
