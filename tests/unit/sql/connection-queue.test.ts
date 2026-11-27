import { expect, test } from 'vitest';

import { queuedPool, WAIT_TIMEOUT_MESSAGE } from '../../../src/sql/connection-queue.ts';
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
