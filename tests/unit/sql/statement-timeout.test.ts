import pg from 'pg';
import { afterEach, expect, test, vi } from 'vitest';

import { AccessMode, getSqlDriver } from '../../../src/sql/driver-factory.ts';
import { DbConnPool } from '../../../src/sql/sql-driver.ts';
import { createFakePool, databaseError, noRowsResult } from '../../support/fake-pool.ts';
import type { QueryHandler } from '../../support/fake-pool.ts';

const RESTRICTED_TIMEOUT_MESSAGE =
  'Query execution timed out after 30 seconds in restricted mode. Consider simplifying your query or increasing the timeout.';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Makes every performance.now() read a minute later than the last, so a query always appears to have run past its timeout. */
function elapseTimeoutPerRead(): void {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => (now += 60_000));
}

function setup(handler?: QueryHandler) {
  const fake = createFakePool(handler);
  const conn = new DbConnPool('postgresql://user:pass@localhost/db', () => fake.pool);
  return { fake, conn };
}

// Statements issued after the connection probe.
function issued(fake: ReturnType<typeof createFakePool>): string[] {
  return fake.queries.map((q) => q.text).slice(1);
}

test('restricted mode sets a 30 second server-side statement_timeout right after BEGIN', async () => {
  const { fake, conn } = setup();

  await getSqlDriver(AccessMode.RESTRICTED, conn, { statementTimeoutSeconds: 30 }).executeQuery('SELECT 1');

  expect(issued(fake).slice(0, 2)).toEqual(['BEGIN TRANSACTION READ ONLY', 'SET statement_timeout = 30000']);
});

test('unrestricted mode sets no statement_timeout by default', async () => {
  const { fake, conn } = setup();

  await getSqlDriver(AccessMode.UNRESTRICTED, conn, { statementTimeoutSeconds: 0 }).executeQuery('SELECT 1');

  expect(issued(fake)).toEqual(['BEGIN', 'SELECT 1', 'COMMIT']);
});

test('an explicit statementTimeoutSeconds is applied in milliseconds', async () => {
  const { fake, conn } = setup();

  await getSqlDriver(AccessMode.UNRESTRICTED, conn, { statementTimeoutSeconds: 5 }).executeQuery('SELECT 1');

  expect(issued(fake).slice(0, 2)).toEqual(['BEGIN', 'SET statement_timeout = 5000']);
});

function timingOutPool() {
  return setup(({ text }) => {
    if (text.includes('slow_table')) {
      throw databaseError('canceling statement due to statement timeout', '57014');
    }
    return [noRowsResult];
  });
}

test('restricted mode reports a Postgres statement timeout with the restricted-mode message', async () => {
  elapseTimeoutPerRead();
  const { conn } = timingOutPool();

  const pending = getSqlDriver(AccessMode.RESTRICTED, conn, { statementTimeoutSeconds: 30 }).executeQuery(
    'SELECT * FROM slow_table'
  );

  await expect(pending).rejects.toThrow(RESTRICTED_TIMEOUT_MESSAGE);
  await expect(pending).rejects.not.toBeInstanceOf(pg.DatabaseError);
});

test('unrestricted mode with a timeout reports it without the restricted-mode wording', async () => {
  elapseTimeoutPerRead();
  const { conn } = timingOutPool();

  const pending = getSqlDriver(AccessMode.UNRESTRICTED, conn, { statementTimeoutSeconds: 5 }).executeQuery(
    'SELECT * FROM slow_table'
  );

  await expect(pending).rejects.toThrow(
    'Query execution timed out after 5 seconds. Consider simplifying your query or increasing the timeout.'
  );
  await expect(pending).rejects.not.toBeInstanceOf(pg.DatabaseError);
});

test('a 57014 that arrives before the timeout elapsed is rethrown as the original Postgres error', async () => {
  const { conn } = setup(({ text }) => {
    if (text.includes('slow_table')) {
      throw databaseError('canceling statement due to user request', '57014');
    }
    return [noRowsResult];
  });

  const pending = getSqlDriver(AccessMode.UNRESTRICTED, conn, { statementTimeoutSeconds: 5 }).executeQuery(
    'SELECT * FROM slow_table'
  );

  await expect(pending).rejects.toBeInstanceOf(pg.DatabaseError);
  await expect(pending).rejects.toThrow('canceling statement due to user request');
});

test('aborting the signal while the statement runs cancels it in Postgres and rejects with Query cancelled', async () => {
  const controller = new AbortController();
  const fake = createFakePool(({ text }) => (text.includes('slow_table') ? fake.hang() : [noRowsResult]));
  const conn = new DbConnPool('postgresql://user:pass@localhost/db', () => fake.pool);
  const driver = getSqlDriver(AccessMode.RESTRICTED, conn, { signal: controller.signal, statementTimeoutSeconds: 30 });

  const pending = driver.executeQuery('SELECT * FROM slow_table');
  await expect.poll(() => fake.queries.some((q) => q.text.includes('slow_table'))).toBe(true);
  expect(fake.cancel).not.toHaveBeenCalled();
  controller.abort();

  await expect(pending).rejects.toThrow('Query cancelled');
  await expect(pending).rejects.not.toBeInstanceOf(pg.DatabaseError);
  expect(fake.cancel).toHaveBeenCalledOnce();
});

test('a signal aborted before the call sends no statement', async () => {
  const { fake, conn } = setup();
  const driver = getSqlDriver(AccessMode.UNRESTRICTED, conn, {
    signal: AbortSignal.abort(),
    statementTimeoutSeconds: 0,
  });

  await expect(driver.executeQuery('SELECT 1')).rejects.toThrow('Query cancelled');

  expect(fake.queries).toEqual([]);
});

test('a cancelled call does not invalidate the pool, so the next call does not reconnect', async () => {
  const controller = new AbortController();
  const fake = createFakePool(({ text }) => (text.includes('slow_table') ? fake.hang() : [noRowsResult]));
  const conn = new DbConnPool('postgresql://user:pass@localhost/db', () => fake.pool);

  const cancelled = getSqlDriver(AccessMode.UNRESTRICTED, conn, {
    signal: controller.signal,
    statementTimeoutSeconds: 0,
  }).executeQuery('SELECT * FROM slow_table');
  await expect.poll(() => fake.queries.some((q) => q.text.includes('slow_table'))).toBe(true);
  controller.abort();
  await expect(cancelled).rejects.toThrow('Query cancelled');
  await getSqlDriver(AccessMode.UNRESTRICTED, conn, { statementTimeoutSeconds: 0 }).executeQuery('SELECT 2');

  expect(conn.isValid).toBe(true);
  expect(fake.queries.filter((q) => q.text === 'SELECT 1')).toHaveLength(1);
});
