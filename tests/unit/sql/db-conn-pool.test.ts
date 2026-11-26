import { expect, test, vi } from 'vitest';

import type { PoolFactory } from '../../../src/sql/sql-driver.ts';
import { DbConnPool } from '../../../src/sql/sql-driver.ts';
import { createFakePool } from '../../support/fake-pool.ts';

const URL = 'postgresql://user:pass@localhost/db';

test('poolConnect opens the pool, probes it with SELECT 1 and marks it valid', async () => {
  const fake = createFakePool();
  const factory = vi.fn<PoolFactory>(() => fake.pool);
  const dbPool = new DbConnPool(URL, factory);

  const pool = await dbPool.poolConnect();

  expect(pool).toBe(fake.pool);
  expect(factory).toHaveBeenCalledExactlyOnceWith(URL);
  expect(fake.queries.map((q) => q.text)).toEqual(['SELECT 1']);
  expect(fake.releases).toHaveLength(1);
  expect(dbPool.isValid).toBe(true);
  expect(dbPool.lastError).toBeNull();
});

test('poolConnect succeeds on a second attempt after the first fails', async () => {
  const good = createFakePool();
  const bad = createFakePool(() => {
    throw new Error('Connection error');
  });
  const factory = vi.fn<PoolFactory>().mockReturnValueOnce(bad.pool).mockReturnValueOnce(good.pool);
  const dbPool = new DbConnPool(URL, factory);

  await expect(dbPool.poolConnect()).rejects.toThrow('Connection attempt failed: Connection error');
  const pool = await dbPool.poolConnect();

  expect(pool).toBe(good.pool);
  expect(dbPool.isValid).toBe(true);
});

test('poolConnect failure closes the pool, marks it invalid and obfuscates the thrown message', async () => {
  const fake = createFakePool(() => {
    throw new Error('could not connect to postgresql://user:hunter2@localhost/db');
  });
  const dbPool = new DbConnPool(URL, () => fake.pool);

  const failure = dbPool.poolConnect();
  await expect(failure).rejects.toThrow(
    'Connection attempt failed: could not connect to postgresql://user:****@localhost/db'
  );

  expect(dbPool.isValid).toBe(false);
  expect(dbPool.lastError).not.toContain('hunter2');
  expect(dbPool.lastError).toContain('user:****@localhost');
  expect(dbPool.pool).toBeNull();
  expect(fake.end).toHaveBeenCalledOnce();
});

test('poolConnect without a URL throws and records the error', async () => {
  const factory = vi.fn<PoolFactory>();
  const dbPool = new DbConnPool(undefined, factory);

  await expect(dbPool.poolConnect()).rejects.toThrow('Database connection URL not provided');

  expect(dbPool.isValid).toBe(false);
  expect(dbPool.lastError).toBe('Database connection URL not provided');
  expect(factory).not.toHaveBeenCalled();
});

test('poolConnect returns the existing pool without reconnecting when it is valid', async () => {
  const fake = createFakePool();
  const factory = vi.fn<PoolFactory>(() => fake.pool);
  const dbPool = new DbConnPool(URL, factory);
  const first = await dbPool.poolConnect();

  const second = await dbPool.poolConnect();

  expect(second).toBe(first);
  expect(factory).toHaveBeenCalledOnce();
});

test('poolConnect rebuilds the pool after it was marked invalid', async () => {
  const first = createFakePool();
  const second = createFakePool();
  const factory = vi.fn<PoolFactory>().mockReturnValueOnce(first.pool).mockReturnValueOnce(second.pool);
  const dbPool = new DbConnPool(URL, factory);
  await dbPool.poolConnect();
  dbPool.markInvalid(new Error('boom'));

  const pool = await dbPool.poolConnect();

  expect(pool).toBe(second.pool);
  expect(first.end).toHaveBeenCalledOnce();
});

test('close ends the pool and marks it invalid', async () => {
  const fake = createFakePool();
  const dbPool = new DbConnPool(URL, () => fake.pool);
  await dbPool.poolConnect();

  await dbPool.close();

  expect(dbPool.isValid).toBe(false);
  expect(dbPool.pool).toBeNull();
  expect(fake.end).toHaveBeenCalledOnce();
});

test('close swallows errors from ending the pool', async () => {
  const fake = createFakePool();
  fake.end.mockRejectedValueOnce(new Error('Error closing pool'));
  const dbPool = new DbConnPool(URL, () => fake.pool);
  await dbPool.poolConnect();

  await expect(dbPool.close()).resolves.toBeUndefined();

  expect(dbPool.isValid).toBe(false);
  expect(dbPool.pool).toBeNull();
});

test('connectionUrl can be read and replaced', () => {
  const dbPool = new DbConnPool(URL);
  expect(dbPool.connectionUrl).toBe(URL);

  dbPool.connectionUrl = 'postgresql://newuser:newpass@otherhost/otherdb';
  expect(dbPool.connectionUrl).toBe('postgresql://newuser:newpass@otherhost/otherdb');
});

test('concurrent poolConnect calls on an invalid pool build one new pool and end the old one once', async () => {
  const first = createFakePool();
  const second = createFakePool();
  const factory = vi.fn<PoolFactory>().mockReturnValueOnce(first.pool).mockReturnValueOnce(second.pool);
  const dbPool = new DbConnPool(URL, factory);
  await dbPool.poolConnect();
  dbPool.markInvalid(new Error('boom'));

  const [a, b] = await Promise.all([dbPool.poolConnect(), dbPool.poolConnect()]);

  expect(a).toBe(second.pool);
  expect(b).toBe(second.pool);
  expect(factory).toHaveBeenCalledTimes(2);
  expect(first.end).toHaveBeenCalledOnce();
  expect(second.end).not.toHaveBeenCalled();
});
