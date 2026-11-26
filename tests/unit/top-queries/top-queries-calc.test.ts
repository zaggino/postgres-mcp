import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionStatus } from "../../../src/sql/extension-utils.ts";
import type { SqlExecutor } from "../../../src/sql/safe-sql.ts";
import type { RowResult } from "../../../src/sql/sql-driver.ts";
import { TopQueriesCalc } from "../../../src/top-queries/top-queries-calc.ts";

const extensionUtils = vi.hoisted(() => ({
  checkExtension: vi.fn(),
  getPostgresVersion: vi.fn(),
}));

vi.mock("../../../src/sql/extension-utils.ts", () => extensionUtils);

type ExecuteQuery = SqlExecutor["executeQuery"];

function row(cells: Record<string, unknown>): RowResult {
  return { cells };
}

function extensionStatus(isInstalled: boolean): ExtensionStatus {
  return {
    isInstalled,
    isAvailable: true,
    name: "pg_stat_statements",
    message: isInstalled ? "Extension is installed" : "Extension not installed",
    defaultVersion: isInstalled ? "1.0" : null,
  };
}

/** A driver that simulates the given PostgreSQL major version. */
function createDriver(pgVersion: number): {
  driver: SqlExecutor;
  executeQuery: ReturnType<typeof vi.fn<ExecuteQuery>>;
} {
  extensionUtils.getPostgresVersion.mockResolvedValue(pgVersion);
  const [total, mean] =
    pgVersion >= 13
      ? ["total_exec_time", "mean_exec_time"]
      : ["total_time", "mean_time"];
  const executeQuery = vi.fn<ExecuteQuery>((query) =>
    Promise.resolve(
      query.includes("pg_stat_statements")
        ? [
            row({
              query: "SELECT * FROM users",
              calls: 100,
              [total]: 1000,
              [mean]: 10,
              rows: 1000,
            }),
            row({
              query: "SELECT * FROM orders",
              calls: 50,
              [total]: 750,
              [mean]: 15,
              rows: 500,
            }),
            row({
              query: "SELECT * FROM products",
              calls: 200,
              [total]: 500,
              [mean]: 2.5,
              rows: 2000,
            }),
          ]
        : null
    )
  );
  return { driver: { executeQuery }, executeQuery };
}

function executedQuery(
  executeQuery: ReturnType<typeof vi.fn<ExecuteQuery>>
): string {
  return String(executeQuery.mock.lastCall?.[0]);
}

describe(TopQueriesCalc, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    extensionUtils.checkExtension.mockResolvedValue(extensionStatus(true));
  });

  it("sorts by total_time on PostgreSQL 12 when sorting by total", async () => {
    const { driver, executeQuery } = createDriver(12);

    const result = await new TopQueriesCalc(driver).getTopQueriesByTime(
      3,
      "total"
    );

    expect(result).toContain("Top 3 slowest queries by total execution time");
    expect(result).toContain("SELECT * FROM users");
    expect(executedQuery(executeQuery)).toContain("total_time");
    expect(executedQuery(executeQuery)).toContain("ORDER BY total_time DESC");
  });

  it("sorts by mean_time on PostgreSQL 12 when sorting by mean", async () => {
    const { driver, executeQuery } = createDriver(12);

    const result = await new TopQueriesCalc(driver).getTopQueriesByTime(
      3,
      "mean"
    );

    expect(result).toContain(
      "Top 3 slowest queries by mean execution time per call"
    );
    expect(result).toContain("SELECT * FROM orders");
    expect(executedQuery(executeQuery)).toContain("mean_time");
    expect(executedQuery(executeQuery)).toContain("ORDER BY mean_time DESC");
  });

  it("sorts by total_exec_time on PostgreSQL 13 when sorting by total", async () => {
    const { driver, executeQuery } = createDriver(13);

    const result = await new TopQueriesCalc(driver).getTopQueriesByTime(
      3,
      "total"
    );

    expect(result).toContain("Top 3 slowest queries by total execution time");
    expect(result).toContain("SELECT * FROM users");
    expect(executedQuery(executeQuery)).toContain("total_exec_time");
    expect(executedQuery(executeQuery)).toContain(
      "ORDER BY total_exec_time DESC"
    );
  });

  it("sorts by mean_exec_time on PostgreSQL 13 when sorting by mean", async () => {
    const { driver, executeQuery } = createDriver(13);

    const result = await new TopQueriesCalc(driver).getTopQueriesByTime(
      3,
      "mean"
    );

    expect(result).toContain(
      "Top 3 slowest queries by mean execution time per call"
    );
    expect(result).toContain("SELECT * FROM orders");
    expect(executedQuery(executeQuery)).toContain("mean_exec_time");
    expect(executedQuery(executeQuery)).toContain(
      "ORDER BY mean_exec_time DESC"
    );
  });

  it("returns installation instructions when the extension is not installed", async () => {
    const { driver, executeQuery } = createDriver(13);
    extensionUtils.checkExtension.mockResolvedValue(extensionStatus(false));

    const result = await new TopQueriesCalc(driver).getTopQueriesByTime(3);

    expect(result).toContain("extension is required to report");
    expect(result).toContain("CREATE EXTENSION");
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it("reports a database error instead of throwing", async () => {
    const { driver, executeQuery } = createDriver(13);
    executeQuery.mockRejectedValue(new Error("Database error"));

    const result = await new TopQueriesCalc(driver).getTopQueriesByTime(3);

    expect(result).toContain("Error getting slow queries: Database error");
  });

  it("aliases the PostgreSQL 12 columns and zeroes wal_bytes in resource queries", async () => {
    const { driver, executeQuery } = createDriver(12);

    await new TopQueriesCalc(driver).getTopResourceQueries(0.05);

    const query = executedQuery(executeQuery);
    expect(query).toContain("stddev_time AS stddev_exec_time");
    expect(query).toContain("total_time AS total_exec_time");
    expect(query).toContain("mean_time AS mean_exec_time");
    expect(query).toContain("0 AS wal_bytes");
  });

  it("uses the PostgreSQL 13 columns and wal_bytes in resource queries", async () => {
    const { driver, executeQuery } = createDriver(13);

    await new TopQueriesCalc(driver).getTopResourceQueries(0.05);

    const query = executedQuery(executeQuery);
    expect(query).toContain("stddev_exec_time");
    expect(query).toContain("total_exec_time");
    expect(query).toContain("mean_exec_time");
    expect(query).toContain("wal_bytes");
  });
});
