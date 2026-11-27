import { expect, test } from 'vitest';

import { PoolClosedError, queuedPool, WAIT_TIMEOUT_MESSAGE } from '../../../src/sql/connection-queue.ts';
import { createFakePool } from '../../support/fake-pool.ts';

test('a checkout cancelled while the pool is full leaves the queue and never takes a client', async () => {
  const fake = createFakePool();
  let checkouts = 0;
  const pool = queuedPool(
    {
      connect: () => {
        checkouts += 1;
        return fake.pool.connect();
      },
      end: fake.end,
    },
    1,
    60_000
  );
  const held = await pool.connect();
  const controller = new AbortController();
  const cancelled = pool.connect(controller.signal);
  const live = pool.connect();

  controller.abort();
  await expect(cancelled).rejects.toBe(controller.signal.reason);
  held.release();
  const next = await live;
  next.release();

  expect(checkouts).toBe(2);
});

test('a checkout that gets no free client within the wait timeout fails with pg-pool message', async () => {
  const fake = createFakePool();
  const pool = queuedPool(fake.pool, 1, 20);
  const held = await pool.connect();

  await expect(pool.connect()).rejects.toThrow(WAIT_TIMEOUT_MESSAGE);

  held.release();
  const next = await pool.connect();
  next.release();
  expect(fake.releases).toHaveLength(2);
});

test('a release that throws still frees its slot for the next checkout', async () => {
  const fake = createFakePool();
  const pool = queuedPool(
    {
      connect: async () => {
        const client = await fake.pool.connect();
        return {
          ...client,
          release: () => {
            throw new Error('Release called on client which has already been released to the pool.');
          },
        };
      },
      end: fake.end,
    },
    1,
    60_000
  );
  const held = await pool.connect();

  expect(() => {
    held.release();
  }).toThrow('already been released');

  await expect(pool.connect()).resolves.toBeDefined();
});

test('closing the pool fails the checkouts still waiting at once', async () => {
  const fake = createFakePool();
  const pool = queuedPool(fake.pool, 1, 60_000);
  await pool.connect();
  const waiting = pool.connect();

  await pool.end();

  await expect(waiting).rejects.toBeInstanceOf(PoolClosedError);
});
