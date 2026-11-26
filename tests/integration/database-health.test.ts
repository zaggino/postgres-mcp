import { afterEach, beforeEach, expect, test } from 'vitest';

import { DatabaseHealthTool } from '../../src/database-health/database-health.ts';
import { SqlDriver } from '../../src/sql/sql-driver.ts';
import { describeWithPostgres } from '../support/postgres.ts';

async function setupTestTables(sqlDriver: SqlDriver): Promise<void> {
  const statements = [
    // Drop existing tables if they exist
    'DROP TABLE IF EXISTS test_orders',
    'DROP TABLE IF EXISTS "UpperCaseOrders"',
    'DROP TABLE IF EXISTS test_customers',
    'DROP SEQUENCE IF EXISTS test_seq',

    // Create test sequence
    'CREATE SEQUENCE test_seq',

    // Create tables with various features to test health checks
    `
            CREATE TABLE test_customers (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT UNIQUE,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `,

    // Lowercase table name (original test case)
    `
            CREATE TABLE test_orders (
                id SERIAL PRIMARY KEY,
                customer_id INTEGER REFERENCES test_customers(id),
                total DECIMAL NOT NULL CHECK (total >= 0),
                status TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `,

    // Uppercase table name to test quoted identifier handling (PR #94 fix)
    `
            CREATE TABLE "UpperCaseOrders" (
                id SERIAL PRIMARY KEY,
                customer_id INTEGER REFERENCES test_customers(id),
                amount DECIMAL NOT NULL,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `,

    // Create some indexes to test index health
    `
            CREATE INDEX idx_orders_customer ON test_orders(customer_id)
            `,
    `
            CREATE INDEX idx_orders_status ON test_orders(status)
            `,
    `
            CREATE INDEX idx_orders_created ON test_orders(created_at)
            `,
    // Create a duplicate index to test duplicate index detection
    `
            CREATE INDEX idx_orders_customer_dup ON test_orders(customer_id)
            `,

    // Insert some test data
    `
            INSERT INTO test_customers (name, email)
            SELECT
                'Customer ' || i,
                'customer' || i || '@example.com'
            FROM generate_series(1, 100) i
        `,

    `
            INSERT INTO test_orders (customer_id, total, status)
            SELECT
                (random() * 99)::int + 1,  -- Changed to ensure IDs are between 1 and 100
                (random() * 1000)::decimal,
                CASE (random() * 2)::int
                    WHEN 0 THEN 'pending'
                    WHEN 1 THEN 'completed'
                    ELSE 'cancelled'
                END
            FROM generate_series(1, 1000) i
        `,

    // Insert data into uppercase table to test sequence handling
    `
            INSERT INTO "UpperCaseOrders" (customer_id, amount)
            SELECT
                (random() * 99)::int + 1,
                (random() * 500)::decimal
            FROM generate_series(1, 100) i
        `,

    // Run ANALYZE to update statistics
    'ANALYZE test_customers',
    'ANALYZE test_orders',
    'ANALYZE "UpperCaseOrders"',
  ];
  for (const statement of statements) {
    await sqlDriver.executeQuery(statement);
  }
}

async function cleanupTestTables(sqlDriver: SqlDriver): Promise<void> {
  await sqlDriver.executeQuery('DROP TABLE IF EXISTS test_orders');
  await sqlDriver.executeQuery('DROP TABLE IF EXISTS "UpperCaseOrders"');
  await sqlDriver.executeQuery('DROP TABLE IF EXISTS test_customers');
  await sqlDriver.executeQuery('DROP SEQUENCE IF EXISTS test_seq');
}

describeWithPostgres('database health with a real database', (postgres) => {
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

  test('reports every health check for health type all', async () => {
    const healthTool = new DatabaseHealthTool(sqlDriver);

    const healthReport = await healthTool.health('all');

    expect(healthReport).toBeTypeOf('string');
    // Check that all health components are present
    expect(healthReport).toContain('Invalid index check:');
    expect(healthReport).toContain('Duplicate index check:');
    expect(healthReport).toContain('Index bloat:');
    expect(healthReport).toContain('Unused index check:');
    expect(healthReport).toContain('Connection health:');
    expect(healthReport).toContain('Vacuum health:');
    expect(healthReport).toContain('Sequence health:');
    expect(healthReport).toContain('Replication health:');
    expect(healthReport).toContain('Buffer health for indexes:');
    expect(healthReport).toContain('Buffer health for tables:');
    expect(healthReport).toContain('Constraint health:');
    // Should detect duplicate index
    expect(healthReport).toContain('idx_orders_customer_dup');
  });
});
