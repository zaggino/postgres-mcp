import { expect, test, vi } from 'vitest';

import { DbConnPool, poolConfig, SqlDriver } from '../../../src/sql/sql-driver.ts';
import type { QueryHandler } from '../../support/fake-pool.ts';
import { createFakePool, noRowsResult, rowsResult } from '../../support/fake-pool.ts';

const TWO_ROWS = [
  { id: 1, name: 'test1' },
  { id: 2, name: 'test2' },
];

function driverFor(handler?: QueryHandler) {
  const fake = createFakePool(handler);
  const conn = new DbConnPool('postgresql://user:pass@localhost/db', () => fake.pool);
  return { fake, conn, driver: new SqlDriver({ conn }) };
}

// Statements issued after the connection probe.
function issued(fake: ReturnType<typeof createFakePool>): string[] {
  return fake.queries.map((q) => q.text).slice(1);
}

test('executeQuery with forceReadonly wraps the query in a read-only transaction rolled back afterwards', async () => {
  const { fake, driver } = driverFor(({ text }) =>
    text === 'SELECT * FROM test' ? [rowsResult(TWO_ROWS)] : [noRowsResult]
  );

  const result = await driver.executeQuery('SELECT * FROM test', null, true);

  expect(issued(fake)).toEqual(['BEGIN TRANSACTION READ ONLY', 'SELECT * FROM test', 'ROLLBACK']);
  expect(result).toHaveLength(2);
  expect(result?.[0]?.cells.id).toBe(1);
  expect(result?.[1]?.cells.name).toBe('test2');
});

test('executeQuery without forceReadonly commits the transaction', async () => {
  const { fake, driver } = driverFor(({ text }) =>
    text.startsWith('UPDATE') ? [rowsResult(TWO_ROWS)] : [noRowsResult]
  );

  const result = await driver.executeQuery("UPDATE test SET name = 'updated'");

  expect(issued(fake)).toEqual(['BEGIN', "UPDATE test SET name = 'updated'", 'COMMIT']);
  expect(result).not.toBeNull();
});

test('executeQuery rethrows the query error, rolls back and invalidates the pool', async () => {
  const { fake, conn, driver } = driverFor(({ text }) => {
    if (text === 'SELECT * FROM nonexistent') {
      throw new Error('Query execution failed');
    }
    return [noRowsResult];
  });

  await expect(driver.executeQuery('SELECT * FROM nonexistent', null, true)).rejects.toThrow('Query execution failed');

  expect(issued(fake)).toEqual(['BEGIN TRANSACTION READ ONLY', 'SELECT * FROM nonexistent', 'ROLLBACK']);
  expect(conn.isValid).toBe(false);
  expect(conn.lastError).toBe('Query execution failed');
  expect(fake.releases.at(-1)).toBe(true);
});

test('executeQuery returns null for statements that produce no result set', async () => {
  const { fake, driver } = driverFor();

  const result = await driver.executeQuery('DELETE FROM test');

  expect(result).toBeNull();
  expect(issued(fake)).toEqual(['BEGIN', 'DELETE FROM test', 'COMMIT']);
});

test('executeQuery returns the rows of the last statement of a multi-statement query', async () => {
  const { driver } = driverFor(({ text }) =>
    text.includes(';') ? [rowsResult([{ first: 1 }]), rowsResult(TWO_ROWS)] : [noRowsResult]
  );

  const result = await driver.executeQuery('SELECT 1 AS first; SELECT * FROM test');

  expect(result?.map((row) => row.cells.id)).toEqual([1, 2]);
});

test('executeQuery returns null when the last statement of a multi-statement query has no result set', async () => {
  const { driver } = driverFor(({ text }) =>
    text.includes(';') ? [rowsResult(TWO_ROWS), noRowsResult] : [noRowsResult]
  );

  const result = await driver.executeQuery('SELECT * FROM test; DELETE FROM test');

  expect(result).toBeNull();
});

test('executeQuery passes params to the query', async () => {
  const { fake, driver } = driverFor(() => [rowsResult(TWO_ROWS)]);

  await driver.executeQuery('SELECT * FROM test WHERE id = $1', [1], true);

  expect(fake.queries).toContainEqual({
    text: 'SELECT * FROM test WHERE id = $1',
    values: [1],
  });
});

test('executeQuery returns rows from the pool connection', async () => {
  const { driver } = driverFor(() => [rowsResult(TWO_ROWS)]);

  const result = await driver.executeQuery('SELECT * FROM test');

  expect(result).toEqual([{ cells: TWO_ROWS[0] }, { cells: TWO_ROWS[1] }]);
});

test('a connection failure rejects executeQuery and marks the pool invalid', async () => {
  const conn = new DbConnPool('postgresql://user:pass@localhost/db', () => {
    throw new Error('Connection failed');
  });
  const driver = new SqlDriver({ conn });

  await expect(driver.executeQuery('SELECT * FROM test')).rejects.toThrow('Connection failed');

  expect(conn.isValid).toBe(false);
  expect(conn.lastError).toContain('Connection failed');
});

test('a driver created from engineUrl builds its pool on connect', () => {
  const driver = new SqlDriver({
    engineUrl: 'postgresql://user:pass@localhost/db',
  });
  expect(driver.conn).toBeNull();

  const conn = driver.connect();

  expect(conn).toBeInstanceOf(DbConnPool);
  expect(conn.connectionUrl).toBe('postgresql://user:pass@localhost/db');
  expect(driver.conn).toBe(conn);
});

test('a driver without conn or engineUrl cannot be created', () => {
  expect(() => new SqlDriver({})).toThrow('Either conn or engineUrl must be provided');
});

test('executeQuery on a failed pool probe does not run the query', async () => {
  const query = vi.fn();
  const { driver } = driverFor(({ text }) => {
    query(text);
    throw new Error('probe failed');
  });

  await expect(driver.executeQuery('SELECT 2')).rejects.toThrow('Connection attempt failed');

  expect(query).toHaveBeenCalledExactlyOnceWith('SELECT 1');
});

test('poolConfig defaults application_name to postgres-mcp for a plain URI', () => {
  expect(poolConfig('postgresql://user:pass@localhost/db', {}).application_name).toBe('postgres-mcp');
});

test('poolConfig keeps an application_name given in the URI', () => {
  expect(poolConfig('postgresql://user:pass@localhost/db?application_name=mine', {}).application_name).toBeUndefined();
});

test('poolConfig keeps an application_name given by PGAPPNAME', () => {
  expect(poolConfig('postgresql://user:pass@localhost/db', { PGAPPNAME: 'mine' }).application_name).toBeUndefined();
});
