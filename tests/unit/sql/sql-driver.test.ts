import type { Socket } from 'node:net';
import { createServer as createNetServer } from 'node:net';

import { expect, test, vi } from 'vitest';

import type { PoolLike } from '../../../src/sql/sql-driver.ts';
import {
  createPoolFactory,
  DbConnPool,
  poolConfig,
  QueryCancelledError,
  SqlDriver,
} from '../../../src/sql/sql-driver.ts';
import type { QueryHandler } from '../../support/fake-pool.ts';
import { createFakePool, databaseError, noRowsResult, rowsResult } from '../../support/fake-pool.ts';

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
  expect(result[0]?.id).toBe(1);
  expect(result[1]?.name).toBe('test2');
});

test('executeQuery without forceReadonly commits the transaction', async () => {
  const { fake, driver } = driverFor(({ text }) =>
    text.startsWith('UPDATE') ? [rowsResult(TWO_ROWS)] : [noRowsResult]
  );

  const result = await driver.executeQuery("UPDATE test SET name = 'updated'");

  expect(issued(fake)).toEqual(['BEGIN', "UPDATE test SET name = 'updated'", 'COMMIT']);
  expect(result).toEqual(TWO_ROWS);
});

test('a statement Postgres rejects is rolled back and keeps the pool and its connection in use', async () => {
  const { fake, conn, driver } = driverFor(({ text }) => {
    if (text === 'SELEC 1') {
      throw databaseError('syntax error at or near "SELEC"', '42601');
    }
    return [noRowsResult];
  });

  await expect(driver.executeQuery('SELEC 1', null, true)).rejects.toThrow('syntax error');
  await driver.executeQuery('SELECT 2');

  expect(issued(fake)).toEqual(['BEGIN TRANSACTION READ ONLY', 'SELEC 1', 'ROLLBACK', 'BEGIN', 'SELECT 2', 'COMMIT']);
  expect(conn.isValid).toBe(true);
  expect(conn.lastError).toBeNull();
  expect(fake.releases).toEqual([undefined, false, false]);
});

test('a lost connection destroys the client and makes the next call reconnect', async () => {
  let lost = true;
  const { fake, conn, driver } = driverFor(({ text }) => {
    if (text === 'SELECT 2' && lost) {
      lost = false;
      throw new Error('Connection terminated unexpectedly');
    }
    return [noRowsResult];
  });

  await expect(driver.executeQuery('SELECT 2')).rejects.toThrow('Connection terminated unexpectedly');
  expect(conn.isValid).toBe(false);
  expect(conn.lastError).toBe('Connection terminated unexpectedly');
  expect(fake.releases.at(-1)).toBe(true);

  await driver.executeQuery('SELECT 2');

  expect(fake.queries.filter((q) => q.text === 'SELECT 1')).toHaveLength(2);
  expect(conn.lastError).toBeNull();
});

test('a statement error whose rollback fails destroys the connection', async () => {
  const { fake, driver } = driverFor(({ text }) => {
    if (text === 'SELEC 1') {
      throw databaseError('syntax error at or near "SELEC"', '42601');
    }
    if (text === 'ROLLBACK') {
      throw new Error('Connection terminated unexpectedly');
    }
    return [noRowsResult];
  });

  await expect(driver.executeQuery('SELEC 1')).rejects.toThrow('syntax error');

  expect(fake.releases.at(-1)).toBe(true);
});

test('a FATAL report is connection-level by its SQLSTATE even when the severity is localized', async () => {
  const { fake, conn, driver } = driverFor(({ text }) => {
    if (text === 'SELECT 2') {
      // databaseError leaves severity unset, as a check on the English word 'FATAL' would see a translated one.
      throw databaseError('terminating connection due to administrator command', '57P01');
    }
    return [noRowsResult];
  });

  await expect(driver.executeQuery('SELECT 2')).rejects.toThrow('administrator command');

  expect(conn.isValid).toBe(false);
  expect(fake.releases.at(-1)).toBe(true);
});

test('a call cancelled before its statement is sent returns its connection to the pool', async () => {
  const controller = new AbortController();
  const fake = createFakePool(({ text }) => {
    if (text === 'BEGIN') {
      controller.abort();
    }
    return [noRowsResult];
  });
  const conn = new DbConnPool('postgresql://user:pass@localhost/db', () => fake.pool);
  const driver = new SqlDriver({ conn, signal: controller.signal });

  await expect(driver.executeQuery('SELECT 2')).rejects.toBeInstanceOf(QueryCancelledError);

  expect(issued(fake)).toEqual(['BEGIN', 'ROLLBACK']);
  expect(fake.releases.at(-1)).toBe(false);
});

test('a checkout failure is recorded without invalidating the pool, and a later cancel keeps it recorded', async () => {
  const fake = createFakePool(({ text }) => (text === 'SELECT 2' ? fake.hang() : [noRowsResult]));
  let checkouts = 0;
  const pool: PoolLike = {
    connect: () => {
      checkouts += 1;
      return checkouts === 2 ? Promise.reject(new Error('sorry, too many clients already')) : fake.pool.connect();
    },
    end: fake.end,
  };
  const conn = new DbConnPool('postgresql://user:pass@localhost/db', () => pool);

  await expect(new SqlDriver({ conn }).executeQuery('SELECT 2')).rejects.toThrow('too many clients');
  expect(conn.isValid).toBe(true);
  expect(conn.lastError).toBe('sorry, too many clients already');

  const controller = new AbortController();
  const cancelled = new SqlDriver({ conn, signal: controller.signal }).executeQuery('SELECT 2');
  await expect.poll(() => fake.queries.some((q) => q.text === 'SELECT 2')).toBe(true);
  controller.abort();
  await expect(cancelled).rejects.toBeInstanceOf(QueryCancelledError);

  expect(conn.lastError).toBe('sorry, too many clients already');
});

test('a recorded error masks every password of a connection URL it echoes', async () => {
  const url = 'postgresql://user:first@secret@localhost/db?password=second';
  const conn = new DbConnPool(url, () => {
    // A message that starts with the URL takes obfuscatePassword's URL-only branch.
    throw new Error(`${url}: connection refused`);
  });

  await expect(new SqlDriver({ conn }).executeQuery('SELECT 2')).rejects.toThrow('Connection attempt failed');

  expect(conn.lastError).not.toMatch(/first|second/u);
});

test('a recorded error masks the password of a URL whose text holds a replacement pattern such as $&', async () => {
  const url = 'postgresql://user:p@hunter2@localhost/db$&';
  const conn = new DbConnPool(url, () => {
    throw new Error(`could not connect to ${url}`);
  });

  await expect(new SqlDriver({ conn }).executeQuery('SELECT 2')).rejects.toThrow('Connection attempt failed');

  expect(conn.lastError).not.toContain('hunter2');
});

test('cancelling a call that waits for a free connection rejects it at once and releases the late connection', async () => {
  const fake = createFakePool();
  let freeConnection = () => {};
  const waitForFree = new Promise<void>((resolve) => {
    freeConnection = resolve;
  });
  let checkouts = 0;
  const pool: PoolLike = {
    connect: () => {
      checkouts += 1;
      // The first checkout is the pool probe; the call's own checkout waits as if the pool were full.
      return checkouts === 1 ? fake.pool.connect() : waitForFree.then(() => fake.pool.connect());
    },
    end: fake.end,
  };
  const conn = new DbConnPool('postgresql://user:pass@localhost/db', () => pool);
  const controller = new AbortController();
  const driver = new SqlDriver({ conn, signal: controller.signal });

  const pending = driver.executeQuery('SELECT 2');
  await expect.poll(() => checkouts).toBe(2);
  controller.abort();
  await expect(pending).rejects.toBeInstanceOf(QueryCancelledError);

  freeConnection();
  await expect.poll(() => fake.releases).toHaveLength(2);
  expect(issued(fake)).toEqual([]);
});

test('connecting to a server that never answers fails after the connect timeout', { timeout: 5000 }, async () => {
  const sockets = new Set<Socket>();
  const silent = createNetServer((socket) => {
    sockets.add(socket);
  });
  await new Promise<void>((resolve) => {
    silent.listen(0, '127.0.0.1', resolve);
  });
  const address = silent.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP address');
  }
  const { port } = address;
  const conn = new DbConnPool(`postgresql://user:pass@127.0.0.1:${port}/db`, createPoolFactory(200));
  try {
    await expect(new SqlDriver({ conn }).executeQuery('SELECT 2')).rejects.toThrow('timeout');
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => {
      silent.close(resolve);
    });
  }
});

test('executeResultSet reports no columns for statements that produce no result set', async () => {
  const { fake, driver } = driverFor();

  const result = await driver.executeResultSet('DELETE FROM test');

  expect(result).toEqual({ columns: [], rows: [] });
  expect(issued(fake)).toEqual(['BEGIN', 'DELETE FROM test', 'COMMIT']);
});

test('executeQuery returns the rows of the last statement of a multi-statement query', async () => {
  const { driver } = driverFor(({ text }) =>
    text.includes(';') ? [rowsResult([{ first: 1 }]), rowsResult(TWO_ROWS)] : [noRowsResult]
  );

  const result = await driver.executeQuery('SELECT 1 AS first; SELECT * FROM test');

  expect(result.map((row) => row.id)).toEqual([1, 2]);
});

test('executeResultSet reports no columns when the last statement of a multi-statement query has no result set', async () => {
  const { driver } = driverFor(({ text }) =>
    text.includes(';') ? [rowsResult(TWO_ROWS), noRowsResult] : [noRowsResult]
  );

  const result = await driver.executeResultSet('SELECT * FROM test; DELETE FROM test');

  expect(result).toEqual({ columns: [], rows: [] });
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

  expect(result).toEqual(TWO_ROWS);
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
  expect(driver.conn).toBeUndefined();

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
