import { afterEach, beforeEach, expect, test } from 'vitest';

import { UsageError } from '../../src/errors.ts';
import { queryRows } from '../../src/sql/safe-sql.ts';
import { SqlDriver } from '../../src/sql/sql-driver.ts';
import { TopQueriesCalc } from '../../src/top-queries/top-queries-calc.ts';
import { describeWithPostgres } from '../support/postgres.ts';

/** Set up test data with sample queries to analyze. */
async function setupTestData(sqlDriver: SqlDriver): Promise<void> {
  // Check if extension exists
  const rows = await queryRows(sqlDriver, "SELECT 1 FROM pg_available_extensions WHERE name = 'pg_stat_statements'");
  if (rows.length === 0) {
    throw new Error('pg_stat_statements extension not available');
  }
  await queryRows(sqlDriver, 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements');

  // Create test tables
  await queryRows(
    sqlDriver,
    `
            DROP TABLE IF EXISTS test_items;
            CREATE TABLE test_items (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                value INTEGER NOT NULL
            )
        `
  );

  // Insert test data
  await queryRows(
    sqlDriver,
    `
            INSERT INTO test_items (name, value)
            SELECT
                'Item ' || i,
                (random() * 1000)::INTEGER
            FROM generate_series(1, 1000) i
        `
  );

  // Reset pg_stat_statements to ensure clean data
  await queryRows(sqlDriver, 'SELECT pg_stat_statements_reset()');

  // Run queries several times to ensure they're captured and have significant stats
  // Query 1: Simple select (should be fast)
  for (let i = 0; i < 10; i += 1) {
    await queryRows(sqlDriver, 'SELECT COUNT(*) FROM test_items');
  }

  // Query 2: More complex query (should be slower)
  for (let i = 0; i < 5; i += 1) {
    await queryRows(
      sqlDriver,
      `
                SELECT name, value
                FROM test_items
                WHERE value > 500
                ORDER BY value DESC
            `
    );
  }

  // Query 3: Very slow query - run more times to ensure it shows up
  for (let i = 0; i < 10; i += 1) {
    await queryRows(
      sqlDriver,
      `
                SELECT t1.name, t2.name
                FROM test_items t1
                CROSS JOIN test_items t2
                WHERE t1.value > t2.value
                LIMIT 100
            `
    );
  }
}

async function cleanupTestData(sqlDriver: SqlDriver): Promise<void> {
  await queryRows(sqlDriver, 'DROP TABLE IF EXISTS test_items');
  await queryRows(sqlDriver, 'SELECT pg_stat_statements_reset()');
}

describeWithPostgres('top queries with a real database', (postgres) => {
  let sqlDriver: SqlDriver;

  beforeEach(() => {
    sqlDriver = new SqlDriver({ engineUrl: postgres.connectionString() });
  });

  afterEach(async () => {
    await sqlDriver.conn?.close();
  });

  test('reports the slowest queries by total and mean execution time', async ({ skip }) => {
    try {
      await setupTestData(sqlDriver);

      // Verify pg_stat_statements has captured our queries
      const pgStats = await queryRows(
        sqlDriver,
        "SELECT query FROM pg_stat_statements WHERE query LIKE '%CROSS JOIN%' LIMIT 1"
      );
      if (pgStats.length === 0) {
        skip('pg_stat_statements did not capture the CROSS JOIN query');
      }

      const calc = new TopQueriesCalc(sqlDriver);

      // Get top queries by total execution time
      const totalResult = await calc.getTopQueriesByTime(10, 'total');

      // Get top queries by mean execution time
      const meanResult = await calc.getTopQueriesByTime(10, 'mean');

      // Basic verification
      expect(totalResult).toContain('slowest queries by total execution time');
      expect(meanResult).toContain('slowest queries by mean execution time');

      // Check for our specific test queries - at least one should be found
      // since we run many different queries
      const hasCrossJoin = totalResult.includes('CROSS JOIN');
      const hasValueGt500 = totalResult.includes('value > 500');
      const hasCount = totalResult.includes('COUNT(*)');

      expect(hasCrossJoin || hasValueGt500 || hasCount).toBe(true);
    } finally {
      await cleanupTestData(sqlDriver);
    }
  });

  test('rejects with installation instructions when pg_stat_statements is not installed', async () => {
    await queryRows(sqlDriver, 'DROP EXTENSION IF EXISTS pg_stat_statements');

    const result = new TopQueriesCalc(sqlDriver).getTopQueriesByTime();

    await expect(result).rejects.toBeInstanceOf(UsageError);
    await expect(result).rejects.toThrow('CREATE EXTENSION pg_stat_statements');
  });
});
