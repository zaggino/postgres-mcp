import { expect, it as test, vi } from 'vitest';

import { createServer } from '../../src/server.ts';
import { AccessMode } from '../../src/sql/driver-factory.ts';
import { databaseError, noRowsResult } from '../support/fake-pool.ts';
import { connectClient } from '../support/mcp-client.ts';
import { createTestRegistry } from '../support/registry.ts';

const SLOW_SQL = 'SELECT pg_sleep(100)';
const SLOW_READ = 'SELECT count(*) FROM big_table';

test('a statement Postgres cancels for the timeout is reported as a timeout with isError', async () => {
  const { registry } = createTestRegistry(['app'], {
    accessMode: AccessMode.RESTRICTED,
    handler: ({ text }) => {
      if (text.includes(SLOW_READ)) {
        throw databaseError('canceling statement due to statement timeout', '57014');
      }
      return [noRowsResult];
    },
  });
  const client = await connectClient(createServer(registry));
  // The fake fails at once; make the query appear to have run past the 30 second timeout.
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => (now += 60_000));

  const result = await client.callTool({ name: 'execute_sql', arguments: { database: 'app', sql: SLOW_READ } });
  vi.restoreAllMocks();

  expect(result).toEqual({
    content: [
      {
        type: 'text',
        text: 'Error: Query execution timed out after 30 seconds in restricted mode. Consider simplifying your query or increasing the timeout.',
      },
    ],
    isError: true,
  });
});

test('cancelling a tool call cancels its running statement in Postgres', async () => {
  const { registry, fakes } = createTestRegistry(['app'], {
    handler: ({ text }) => {
      const fake = fakes.get('app');
      return text === SLOW_SQL && fake ? fake.hang() : [noRowsResult];
    },
  });
  const client = await connectClient(createServer(registry));
  const controller = new AbortController();

  const call = client.callTool({ name: 'execute_sql', arguments: { database: 'app', sql: SLOW_SQL } }, undefined, {
    signal: controller.signal,
  });
  // The abort rejection is the caller's side; the assertion is on what reached Postgres.
  const settled = call.catch(() => null);
  await vi.waitFor(() => {
    expect(fakes.get('app')?.queries.some(({ text }) => text === SLOW_SQL)).toBe(true);
  });
  controller.abort();
  await settled;

  await vi.waitFor(() => {
    expect(fakes.get('app')?.cancel).toHaveBeenCalledOnce();
  });
});
