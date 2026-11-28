import pg from 'pg';
import { expect, it as test, vi } from 'vitest';

import { DatabaseRegistry } from '../../src/database-registry.ts';
import { createServer } from '../../src/server.ts';
import { AccessMode } from '../../src/sql/driver-factory.ts';
import { createFakePool, databaseError, noRowsResult } from '../support/fake-pool.ts';
import { connectClient } from '../support/mcp-client.ts';
import { createTestRegistry } from '../support/registry.ts';

async function executeSql(accessMode: AccessMode, database: string, sql: string) {
  const { registry } = createTestRegistry(['app'], {
    accessMode,
    handler: ({ text }) => {
      if (text.includes('1/0')) {
        throw new pg.DatabaseError('division by zero', 0, 'error');
      }
      if (text.includes('pg_sleep')) {
        throw databaseError('terminating connection due to administrator command', '57P01');
      }
      return [noRowsResult];
    },
  });
  const client = await connectClient(createServer(registry));
  return await client.callTool({ name: 'execute_sql', arguments: { database, sql } });
}

test('an error Postgres raises for the statement keeps the plain upstream result without isError', async () => {
  const result = await executeSql(AccessMode.UNRESTRICTED, 'app', 'SELECT 1/0');

  expect(result).toEqual({ content: [{ type: 'text', text: 'Error: division by zero' }] });
});

test('Postgres ending the connection mid-statement is reported with isError', async () => {
  const result = await executeSql(AccessMode.UNRESTRICTED, 'app', 'SELECT pg_sleep(10)');

  expect(result).toEqual({
    content: [{ type: 'text', text: 'Error: terminating connection due to administrator command' }],
    isError: true,
  });
});

test('an unknown database is reported with isError', async () => {
  const result = await executeSql(AccessMode.UNRESTRICTED, 'missing', 'SELECT 1');

  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain('Error: Unknown database');
});

test('a restricted-mode rejection is reported with isError', async () => {
  const result = await executeSql(AccessMode.RESTRICTED, 'app', 'DROP TABLE x');

  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain('Error: Error validating query');
});

test('a Postgres error while checking out a connection is reported with isError', async () => {
  const registry = new DatabaseRegistry({
    accessMode: AccessMode.UNRESTRICTED,
    idleMinutes: 0,
    statementTimeoutSeconds: 0,
    databases: [{ name: 'app', source: 'cli', uri: { uri: 'postgresql://u:p@h:5432/app' } }],
    servers: [],
    poolFactory: () => {
      const { pool } = createFakePool();
      const connect = pool.connect.bind(pool);
      let checkouts = 0;
      // The pool's own connection check succeeds; the checkout for the statement is refused.
      pool.connect = () => {
        checkouts += 1;
        return checkouts === 1 ? connect() : Promise.reject(new pg.DatabaseError('too many clients', 0, 'error'));
      };
      return pool;
    },
  });
  const client = await connectClient(createServer(registry));

  const result = await client.callTool({ name: 'execute_sql', arguments: { database: 'app', sql: 'SELECT 1' } });

  expect(result).toEqual({ content: [{ type: 'text', text: 'Error: too many clients' }], isError: true });
});

async function callFailingTool(
  name: string,
  args: Record<string, unknown>,
  failure: () => Error = () => new Error('socket hang up')
) {
  const { registry } = createTestRegistry(['app'], {
    handler: ({ text }) => {
      if (text.startsWith('BEGIN') || text.startsWith('ROLLBACK') || text === 'SELECT 1') {
        return [noRowsResult];
      }
      throw failure();
    },
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    const client = await connectClient(createServer(registry));
    const result = await client.callTool({ name, arguments: { database: 'app', ...args } });
    return { result, logged: stderr.mock.calls.map(([line]) => String(line)) };
  } finally {
    stderr.mockRestore();
  }
}

test('a tool failure that is not a Postgres rejection is logged with the tool label and reported with isError', async () => {
  const { result, logged } = await callFailingTool('list_schemas', {});

  expect(result).toEqual({ content: [{ type: 'text', text: 'Error: socket hang up' }], isError: true });
  expect(logged).toContain('ERROR: Error listing schemas: socket hang up\n');
});

test.each([
  ['analyze_db_health', { health_type: 'connection' }],
  ['get_top_queries', {}],
  ['analyze_workload_indexes', {}],
  ['analyze_query_indexes', { queries: ['SELECT 1'] }],
])('a %s connection failure is reported with isError', async (name, args) => {
  const { result } = await callFailingTool(name, args);

  expect(result).toEqual({ content: [{ type: 'text', text: 'Error: socket hang up' }], isError: true });
});

test.each([
  ['get_top_queries', {}],
  ['analyze_query_indexes', { queries: ['SELECT 1'] }],
])('a %s statement Postgres rejects is reported without isError', async (name, args) => {
  const { result } = await callFailingTool(name, args, () => databaseError('permission denied', '42501'));

  expect(result).toEqual({ content: [{ type: 'text', text: 'Error: permission denied' }] });
});

test('an invalid analyze_db_health type is reported with isError and not logged as a server error', async () => {
  const { result, logged } = await callFailingTool('analyze_db_health', { health_type: 'disk' });

  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("Invalid health types provided: 'disk'");
  expect(logged.filter((line) => line.startsWith('ERROR'))).toEqual([]);
});
