import { afterEach, expect, it as test, vi } from "vitest";
import { AccessMode, createServer, deps } from "../../../src/server.ts";
import type { SqlExecutor } from "../../../src/sql/safe-sql.ts";
import { callToolText, connectClient } from "../../support/mcp-client.ts";

const EXECUTION_ERROR = /^Error: .*Error executing query/u;

type ExecuteQuery = SqlExecutor["executeQuery"];

function plan(extra: Record<string, unknown> = {}, node = {}) {
  return {
    Plan: {
      "Node Type": "Seq Scan",
      "Total Cost": 10,
      "Startup Cost": 0,
      "Plan Rows": 5,
      "Plan Width": 4,
      ...node,
    },
    ...extra,
  };
}

/** A driver that answers EXPLAIN with `planData` and reports hypopg installed. */
function useExplainDriver(planData: unknown) {
  const executeQuery = vi.fn<ExecuteQuery>((query) =>
    Promise.resolve(
      query.includes("pg_extension")
        ? [{ cells: { extversion: "1.4.1" } }]
        : [{ cells: { "QUERY PLAN": [planData] } }]
    )
  );
  vi.spyOn(deps, "getSqlDriver").mockReturnValue({ executeQuery });
  return executeQuery;
}

async function explainQuery(args: Record<string, unknown>): Promise<string> {
  const client = await connectClient(createServer(AccessMode.UNRESTRICTED));
  return callToolText(client, "explain_query", args);
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("registers the explain_query tool", async () => {
  const client = await connectClient(createServer(AccessMode.UNRESTRICTED));

  const { tools } = await client.listTools();

  expect(tools.map((tool) => tool.name)).toContain("explain_query");
});

test("explain_query runs a plain EXPLAIN and returns the plan", async () => {
  const executeQuery = useExplainDriver(plan());

  const text = await explainQuery({ sql: "SELECT * FROM users" });

  expect(text).toContain("Seq Scan");
  expect(executeQuery).toHaveBeenCalledWith(
    "EXPLAIN (FORMAT JSON) SELECT * FROM users"
  );
});

test("explain_query with analyze=true runs EXPLAIN ANALYZE and reports execution time", async () => {
  const executeQuery = useExplainDriver(
    plan({ "Execution Time": 1.3 }, { "Actual Rows": 100 })
  );

  const text = await explainQuery({
    sql: "SELECT * FROM users",
    analyze: true,
  });

  expect(executeQuery).toHaveBeenCalledWith(
    "EXPLAIN (FORMAT JSON, ANALYZE) SELECT * FROM users"
  );
  expect(text).toContain("Execution Time: 1.300 ms");
});

test("explain_query with hypothetical indexes creates them before explaining", async () => {
  const executeQuery = useExplainDriver(
    plan({}, { "Node Type": "Index Scan" })
  );

  const text = await explainQuery({
    sql: "SELECT * FROM users WHERE email = 'test@example.com'",
    hypothetical_indexes: [{ table: "users", columns: ["email"] }],
  });

  expect(text).toContain("Index Scan");
  expect(executeQuery.mock.calls.map(([query]) => query).join("\n")).toContain(
    "hypopg_create_index"
  );
});

test("explain_query rejects analyze combined with hypothetical indexes", async () => {
  useExplainDriver(plan());

  const text = await explainQuery({
    sql: "SELECT 1",
    analyze: true,
    hypothetical_indexes: [{ table: "users", columns: ["email"] }],
  });

  expect(text).toBe(
    "Error: Cannot use analyze and hypothetical indexes together"
  );
});

test("explain_query formats a failing EXPLAIN as an error message", async () => {
  vi.spyOn(deps, "getSqlDriver").mockReturnValue({
    executeQuery: vi
      .fn<ExecuteQuery>()
      .mockRejectedValue(new Error("Error executing query")),
  });

  const text = await explainQuery({ sql: "INVALID SQL" });

  expect(text).toMatch(EXECUTION_ERROR);
});
