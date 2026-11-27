import pg from 'pg';
import { expect, it as test } from 'vitest';

import { createServer } from '../../src/server.ts';
import { AccessMode } from '../../src/sql/driver-factory.ts';
import { noRowsResult } from '../support/fake-pool.ts';
import { connectClient } from '../support/mcp-client.ts';
import { createTestRegistry } from '../support/registry.ts';

const ISSUES_URL = 'https://github.com/zaggino/postgres-mcp/issues';

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

async function instructions(options: Parameters<typeof createTestRegistry>[1]) {
  const client = await connectClient(createServer(createTestRegistry(['app'], options).registry));
  return client.getInstructions() ?? '';
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

test('the instructions state the access mode in effect and where to report server issues', async () => {
  const restricted = await instructions({ accessMode: AccessMode.RESTRICTED });
  const unrestricted = await instructions({ accessMode: AccessMode.UNRESTRICTED });

  expect(restricted).toContain('Access mode is restricted');
  expect(unrestricted).toContain('Access mode is unrestricted');
  expect(restricted).toContain(ISSUES_URL);
  expect(unrestricted).toContain(ISSUES_URL);
});

test('the instructions mention discovered-name prefixes only when a server has a prefix', async () => {
  const server = (prefix: string) => ({
    uri: { uri: 'postgresql://u:p@h/postgres' },
    prefix,
    include: ['*'],
    exclude: [],
  });

  await expect(instructions({ servers: [server('dev-')] })).resolves.toContain("carry their server's prefix");
  await expect(instructions({ servers: [server('')] })).resolves.not.toContain('prefix');
});
