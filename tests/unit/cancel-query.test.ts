import { expect, it as test, vi } from 'vitest';

import { createServer } from '../../src/server.ts';
import { noRowsResult } from '../support/fake-pool.ts';
import { callToolText, connectClient } from '../support/mcp-client.ts';
import { createTestRegistry } from '../support/registry.ts';

const SLOW_SQL = 'SELECT pg_sleep(100)';

function setup() {
  const { registry, fakes } = createTestRegistry(['app'], {
    handler: ({ text }) => {
      const fake = fakes.get('app');
      return text === SLOW_SQL && fake ? fake.hang() : [noRowsResult];
    },
  });
  return { fakes, client: connectClient(createServer(registry)) };
}

test('cancel_query lists the running call, cancels it by id, and the call ends with Query cancelled', async () => {
  const { fakes, client: pending } = setup();
  const client = await pending;

  const running = client.callTool({ name: 'execute_sql', arguments: { database: 'app', sql: SLOW_SQL } });
  let callId = '';
  await vi.waitFor(async () => {
    const text = await callToolText(client, 'cancel_query', {});
    const listed: unknown = JSON.parse(text);
    expect(listed).toMatchObject([{ tool: 'execute_sql', database: 'app' }]);
    callId = /"call_id":"(?<id>[^"]+)"/u.exec(text)?.groups?.id ?? '';
  });

  const cancelled: unknown = JSON.parse(await callToolText(client, 'cancel_query', { call_id: callId }));

  expect(cancelled).toEqual({ cancelled: true, call_id: callId });
  await expect(running).resolves.toEqual({
    content: [{ type: 'text', text: 'Error: Query cancelled' }],
    isError: true,
  });
  expect(fakes.get('app')?.cancel).toHaveBeenCalledOnce();
  expect(JSON.parse(await callToolText(client, 'cancel_query', {}))).toEqual([]);
});

test('cancel_query reports an unknown call id as an error', async () => {
  const client = await setup().client;

  const result = await client.callTool({ name: 'cancel_query', arguments: { call_id: 'nope' } });

  expect(result.isError).toBe(true);
  expect(result.content).toEqual([{ type: 'text', text: 'Error: No running call with call_id "nope"' }]);
});
