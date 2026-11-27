import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import pg from 'pg';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { z } from 'zod';

import { DatabaseRegistry } from '../../src/database-registry.ts';
import { createServer } from '../../src/server.ts';
import { AccessMode } from '../../src/sql/driver-factory.ts';
import { connectClient } from '../support/mcp-client.ts';
import { describeWithPostgres } from '../support/postgres.ts';

const CallList = z.array(z.object({ call_id: z.string(), tool: z.string(), database: z.string() }));

function toolResult(raw: unknown): { text: string; isError: boolean } {
  const { content, isError } = CallToolResultSchema.parse(raw);
  const [item] = content;
  if (item?.type !== 'text') {
    throw new Error('Expected a text content item');
  }
  return { text: item.text, isError: isError === true };
}

describeWithPostgres('statement timeout and cancellation', ({ connectionString }) => {
  const registries: DatabaseRegistry[] = [];
  let admin: pg.Pool;

  function makeClient(statementTimeoutSeconds = 0): Promise<Client> {
    const registry = new DatabaseRegistry({
      accessMode: AccessMode.UNRESTRICTED,
      idleMinutes: 0,
      statementTimeoutSeconds,
      databases: [{ name: 'app', source: 'cli', uri: { uri: connectionString() } }],
      servers: [],
    });
    registries.push(registry);
    return connectClient(createServer(registry));
  }

  /** Backends of this server running a statement that contains `fragment`, optionally only the active ones. */
  async function backends(fragment: string, activeOnly: boolean): Promise<number> {
    const { rows } = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_stat_activity
       WHERE application_name = 'postgres-mcp' AND pid <> pg_backend_pid()
         AND query LIKE $1 ${activeOnly ? "AND state = 'active'" : ''}`,
      [`%${fragment}%`]
    );
    return Number(rows[0]?.n);
  }

  async function startSleep(
    client: Client,
    seconds: string,
    signal?: AbortSignal
  ): Promise<{ call: Promise<unknown>; fragment: string }> {
    const fragment = `pg_sleep(${seconds})`;
    const call = client.callTool(
      { name: 'execute_sql', arguments: { database: 'app', sql: `SELECT ${fragment}` } },
      undefined,
      signal ? { signal } : undefined
    );
    await vi.waitFor(async () => {
      await expect(backends(fragment, true)).resolves.toBe(1);
    });
    return { call, fragment };
  }

  beforeAll(() => {
    admin = new pg.Pool({ connectionString: connectionString() });
  });

  afterAll(async () => {
    await Promise.all(registries.map((registry) => registry.closeAll()));
    await admin.end();
  });

  test('a statement over statementTimeoutSeconds is stopped in Postgres and reported as a timeout', async () => {
    const client = await makeClient(1);

    const result = toolResult(
      await client.callTool({ name: 'execute_sql', arguments: { database: 'app', sql: 'SELECT pg_sleep(5)' } })
    );

    expect(result).toEqual({
      text: 'Error: Query execution timed out after 1 seconds. Consider simplifying your query or increasing the timeout.',
      isError: true,
    });
    await expect(backends('pg_sleep(5)', false)).resolves.toBe(0);
  });

  test('aborting a tool call cancels its statement in Postgres', async () => {
    const client = await makeClient();
    const controller = new AbortController();
    const { call, fragment } = await startSleep(client, '30.1', controller.signal);
    const settled = call.catch(() => null);

    controller.abort();
    await settled;

    await vi.waitFor(
      async () => {
        await expect(backends(fragment, true)).resolves.toBe(0);
      },
      { timeout: 5000 }
    );
  });

  test('cancel_query lists a running call and cancels it', async () => {
    const client = await makeClient();
    const { call, fragment } = await startSleep(client, '30.2');

    const listed = await vi.waitFor(async () => {
      const calls = CallList.parse(
        JSON.parse(toolResult(await client.callTool({ name: 'cancel_query', arguments: {} })).text)
      ).filter((entry) => entry.tool === 'execute_sql');
      expect(calls).toHaveLength(1);
      return calls;
    });
    const callId = listed[0]?.call_id;
    expect(callId).toBeDefined();
    expect(listed[0]?.database).toBe('app');

    await client.callTool({ name: 'cancel_query', arguments: { call_id: callId } });

    expect(toolResult(await call)).toEqual({ text: 'Error: Query cancelled', isError: true });
    await vi.waitFor(
      async () => {
        await expect(backends(fragment, true)).resolves.toBe(0);
      },
      { timeout: 5000 }
    );
  });

  test('the timeout still applies after the statement itself commits the transaction', async () => {
    const client = await makeClient(1);

    const result = toolResult(
      await client.callTool({
        name: 'execute_sql',
        arguments: { database: 'app', sql: 'COMMIT; SELECT pg_sleep(5.3)' },
      })
    );

    expect(result).toEqual({
      text: 'Error: Query execution timed out after 1 seconds. Consider simplifying your query or increasing the timeout.',
      isError: true,
    });
  });
});
