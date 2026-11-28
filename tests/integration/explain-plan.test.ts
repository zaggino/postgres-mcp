import { afterEach, beforeEach, expect, test } from 'vitest';

import { ErrorResult, ExplainPlanArtifact } from '../../src/artifacts.ts';
import { ExplainPlanTool } from '../../src/explain/explain-plan.ts';
import { queryRows } from '../../src/sql/safe-sql.ts';
import { SqlDriver } from '../../src/sql/sql-driver.ts';
import { describeWithPostgres } from '../support/postgres.ts';

async function setupTestTables(sqlDriver: SqlDriver): Promise<void> {
  // Drop existing tables if they exist
  await queryRows(sqlDriver, 'DROP TABLE IF EXISTS test_orders');
  await queryRows(sqlDriver, 'DROP TABLE IF EXISTS test_customers');

  // Create tables with various features for testing explain plan
  await queryRows(
    sqlDriver,
    `
            CREATE TABLE test_customers (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT UNIQUE,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `
  );

  await queryRows(
    sqlDriver,
    `
            CREATE TABLE test_orders (
                id SERIAL PRIMARY KEY,
                customer_id INTEGER REFERENCES test_customers(id),
                total DECIMAL NOT NULL,
                status TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `
  );

  // Create some indexes to test explain plans
  await queryRows(
    sqlDriver,
    `
            CREATE INDEX idx_orders_customer ON test_orders(customer_id)
            `
  );
  await queryRows(
    sqlDriver,
    `
            CREATE INDEX idx_orders_status ON test_orders(status)
            `
  );

  // Insert some test data
  await queryRows(
    sqlDriver,
    `
            INSERT INTO test_customers (name, email)
            SELECT
                'Customer ' || i,
                'customer' || i || '@example.com'
            FROM generate_series(1, 100) i
        `
  );

  await queryRows(
    sqlDriver,
    `
            INSERT INTO test_orders (customer_id, total, status)
            SELECT
                (random() * 99)::int + 1,
                (random() * 1000)::decimal,
                CASE (random() * 2)::int
                    WHEN 0 THEN 'pending'
                    WHEN 1 THEN 'completed'
                    ELSE 'cancelled'
                END
            FROM generate_series(1, 1000) i
        `
  );

  // Run ANALYZE to update statistics
  await queryRows(sqlDriver, 'ANALYZE test_customers');
  await queryRows(sqlDriver, 'ANALYZE test_orders');
}

async function cleanupTestTables(sqlDriver: SqlDriver): Promise<void> {
  await queryRows(sqlDriver, 'DROP TABLE IF EXISTS test_orders');
  await queryRows(sqlDriver, 'DROP TABLE IF EXISTS test_customers');
}

const RELATION_NOT_EXIST = /relation.*not exist/u;

function parsePlan(result: ExplainPlanArtifact): Record<string, unknown> {
  const parsed: unknown = JSON.parse(result.value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Expected the plan to be a JSON object');
  }
  return Object.fromEntries(Object.entries(parsed));
}

function planOf(planData: Record<string, unknown>): Record<string, unknown> {
  const plan = planData.Plan;
  if (typeof plan !== 'object' || plan === null || Array.isArray(plan)) {
    throw new Error('Expected a Plan object');
  }
  return Object.fromEntries(Object.entries(plan));
}

describeWithPostgres('explain plan with a real database', (postgres) => {
  let sqlDriver: SqlDriver;

  beforeEach(async () => {
    sqlDriver = new SqlDriver({ engineUrl: postgres.connectionString() });
    await setupTestTables(sqlDriver);
  });

  afterEach(async () => {
    try {
      await cleanupTestTables(sqlDriver);
    } finally {
      await sqlDriver.conn?.close();
    }
  });

  test('explains a query with a real database connection', async () => {
    const tool = new ExplainPlanTool(sqlDriver);

    const result = await tool.explain('SELECT * FROM test_customers WHERE id = 1');

    expect(result).toBeInstanceOf(ExplainPlanArtifact);
    if (!(result instanceof ExplainPlanArtifact)) {
      return;
    }
    const planData = parsePlan(result);
    expect(planData).toHaveProperty('Plan');
    expect(planOf(planData)).toHaveProperty('Node Type');
    // PostgreSQL may choose different scan types depending on statistics;
    // for small tables, a sequential scan may win over an index scan.
    expect(['Index Scan', 'Index Only Scan', 'Seq Scan']).toContain(planOf(planData)['Node Type']);
  });

  test('explains a query with analyze against a real database', async () => {
    const tool = new ExplainPlanTool(sqlDriver);

    const result = await tool.explainAnalyze('SELECT * FROM test_customers WHERE id = 1');

    expect(result).toBeInstanceOf(ExplainPlanArtifact);
    if (!(result instanceof ExplainPlanArtifact)) {
      return;
    }
    const planData = parsePlan(result);
    expect(planData).toHaveProperty('Plan');
    // Check for analyze-specific fields
    expect(planData).toHaveProperty('Execution Time');
    expect(planOf(planData)).toHaveProperty('Actual Rows');
    expect(planOf(planData)).toHaveProperty('Actual Total Time');
  });

  test('explains a join query', async () => {
    const tool = new ExplainPlanTool(sqlDriver);

    const result = await tool.explain(`
        SELECT c.name, o.total, o.status
        FROM test_customers c
        JOIN test_orders o ON c.id = o.customer_id
        WHERE o.status = 'completed'
        `);

    expect(result).toBeInstanceOf(ExplainPlanArtifact);
    if (!(result instanceof ExplainPlanArtifact)) {
      return;
    }
    const planData = parsePlan(result);
    expect(planData).toHaveProperty('Plan');
    // Verify this is a join plan
    expect(planOf(planData)).toHaveProperty('Plans');
  });

  test('explains a query with bind variables', async () => {
    const tool = new ExplainPlanTool(sqlDriver);

    const result = await tool.explain('SELECT * FROM test_customers WHERE id = $1');

    expect(result).toBeInstanceOf(ExplainPlanArtifact);
    if (!(result instanceof ExplainPlanArtifact)) {
      return;
    }
    expect(parsePlan(result)).toBeTypeOf('object');
  });

  test('explains a query with LIKE expressions', async () => {
    const tool = new ExplainPlanTool(sqlDriver);

    const result = await tool.explain("SELECT * FROM test_customers WHERE name LIKE 'Customer%'");

    expect(result).toBeInstanceOf(ExplainPlanArtifact);
    if (!(result instanceof ExplainPlanArtifact)) {
      return;
    }
    const planData = parsePlan(result);
    expect(planData).toHaveProperty('Plan');
    // This should be a sequential scan since there's no index on name
    expect(planOf(planData)['Node Type']).toBe('Seq Scan');
  });

  test('explains a query with both LIKE and bind variables', async () => {
    const tool = new ExplainPlanTool(sqlDriver);

    const result = await tool.explain('SELECT * FROM test_customers WHERE name LIKE $1');

    expect(result).toBeInstanceOf(ExplainPlanArtifact);
    if (!(result instanceof ExplainPlanArtifact)) {
      return;
    }
    expect(parsePlan(result)).toBeTypeOf('object');
  });

  test('returns an error result for an invalid query', async () => {
    const tool = new ExplainPlanTool(sqlDriver);

    const result = await tool.explain('SELECT * FROM nonexistent_table');

    expect(result).toBeInstanceOf(ErrorResult);
    expect(result.value.toLowerCase()).toMatch(RELATION_NOT_EXIST);
  });
});
