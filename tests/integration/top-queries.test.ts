import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { ExtensionStatus } from "../../src/sql/extension-utils.ts";
import { SqlDriver } from "../../src/sql/sql-driver.ts";
import {
  PG_STAT_STATEMENTS,
  TopQueriesCalc,
} from "../../src/top-queries/top-queries-calc.ts";
import { describeWithPostgres } from "../support/postgres.ts";

const checkExtensionOverride = vi.hoisted(() => ({
  status: null as ExtensionStatus | null,
}));

// ESM imports cannot be monkeypatched, so the module is wrapped instead: the
// real check runs unless a test installs an override.
vi.mock("../../src/sql/extension-utils.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/sql/extension-utils.ts")>();
  return {
    ...actual,
    checkExtension: (...args: Parameters<typeof actual.checkExtension>) =>
      checkExtensionOverride.status
        ? Promise.resolve(checkExtensionOverride.status)
        : actual.checkExtension(...args),
  };
});

/** Set up test data with sample queries to analyze. */
async function setupTestData(sqlDriver: SqlDriver): Promise<void> {
  // Check if extension exists
  const rows = await sqlDriver.executeQuery(
    "SELECT 1 FROM pg_available_extensions WHERE name = 'pg_stat_statements'"
  );
  if (!rows || rows.length === 0) {
    throw new Error("pg_stat_statements extension not available");
  }
  await sqlDriver.executeQuery(
    "CREATE EXTENSION IF NOT EXISTS pg_stat_statements"
  );

  // Create test tables
  await sqlDriver.executeQuery(`
            DROP TABLE IF EXISTS test_items;
            CREATE TABLE test_items (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                value INTEGER NOT NULL
            )
        `);

  // Insert test data
  await sqlDriver.executeQuery(`
            INSERT INTO test_items (name, value)
            SELECT
                'Item ' || i,
                (random() * 1000)::INTEGER
            FROM generate_series(1, 1000) i
        `);

  // Reset pg_stat_statements to ensure clean data
  await sqlDriver.executeQuery("SELECT pg_stat_statements_reset()");

  // Run queries several times to ensure they're captured and have significant stats
  // Query 1: Simple select (should be fast)
  for (let i = 0; i < 10; i += 1) {
    await sqlDriver.executeQuery("SELECT COUNT(*) FROM test_items");
  }

  // Query 2: More complex query (should be slower)
  for (let i = 0; i < 5; i += 1) {
    await sqlDriver.executeQuery(`
                SELECT name, value
                FROM test_items
                WHERE value > 500
                ORDER BY value DESC
            `);
  }

  // Query 3: Very slow query - run more times to ensure it shows up
  for (let i = 0; i < 10; i += 1) {
    await sqlDriver.executeQuery(`
                SELECT t1.name, t2.name
                FROM test_items t1
                CROSS JOIN test_items t2
                WHERE t1.value > t2.value
                LIMIT 100
            `);
  }
}

async function cleanupTestData(sqlDriver: SqlDriver): Promise<void> {
  await sqlDriver.executeQuery("DROP TABLE IF EXISTS test_items");
  await sqlDriver.executeQuery("SELECT pg_stat_statements_reset()");
}

describeWithPostgres("top queries with a real database", (postgres) => {
  let sqlDriver: SqlDriver;

  beforeEach(() => {
    checkExtensionOverride.status = null;
    sqlDriver = new SqlDriver({ engineUrl: postgres.connectionString() });
  });

  afterEach(async () => {
    checkExtensionOverride.status = null;
    await sqlDriver.conn?.close();
  });

  test("reports the slowest queries by total and mean execution time", async ({
    skip,
  }) => {
    try {
      await setupTestData(sqlDriver);

      // Verify pg_stat_statements has captured our queries
      const pgStats = await sqlDriver.executeQuery(
        "SELECT query FROM pg_stat_statements WHERE query LIKE '%CROSS JOIN%' LIMIT 1"
      );
      if (!pgStats || pgStats.length === 0) {
        skip("pg_stat_statements did not capture the CROSS JOIN query");
      }

      const calc = new TopQueriesCalc(sqlDriver);

      // Get top queries by total execution time
      const totalResult = await calc.getTopQueriesByTime(10, "total");

      // Get top queries by mean execution time
      const meanResult = await calc.getTopQueriesByTime(10, "mean");

      // Basic verification
      expect(totalResult).toContain("slowest queries by total execution time");
      expect(meanResult).toContain("slowest queries by mean execution time");

      // Check for our specific test queries - at least one should be found
      // since we run many different queries
      const hasCrossJoin = totalResult.includes("CROSS JOIN");
      const hasValueGt500 = totalResult.includes("value > 500");
      const hasCount = totalResult.includes("COUNT(*)");

      expect(hasCrossJoin || hasValueGt500 || hasCount).toBe(true);
    } finally {
      await cleanupTestData(sqlDriver);
    }
  });

  test("returns installation instructions when pg_stat_statements is not installed", async () => {
    const calc = new TopQueriesCalc(sqlDriver);
    checkExtensionOverride.status = {
      isInstalled: false,
      isAvailable: true,
      name: PG_STAT_STATEMENTS,
      message: "Extension not installed",
      defaultVersion: null,
    };

    const result = await calc.getTopQueriesByTime();

    // Check that we get installation instructions
    expect(result).toContain("not currently installed");
    expect(result).toContain("CREATE EXTENSION");
  });
});
