import pg from 'pg';
import { expect, it as test } from 'vitest';

import { DatabaseRegistry } from '../../src/database-registry.ts';
import { createServer } from '../../src/server.ts';
import { AccessMode } from '../../src/sql/driver-factory.ts';
import { createFakePool, noRowsResult } from '../support/fake-pool.ts';
import { connectClient } from '../support/mcp-client.ts';
import { createTestRegistry } from '../support/registry.ts';

async function executeSql(accessMode: AccessMode, database: string, sql: string) {
  const { registry } = createTestRegistry(['app'], {
    accessMode,
    handler: ({ text }) => {
      if (text.includes('1/0')) {
        throw new pg.DatabaseError('division by zero', 0, 'error');
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
