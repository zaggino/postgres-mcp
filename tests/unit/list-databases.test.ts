import { expect, it as test } from 'vitest';

import { createServer } from '../../src/server.ts';
import { queryRows } from '../../src/sql/safe-sql.ts';
import { arrayRowsResult, noRowsResult, rowsResult } from '../support/fake-pool.ts';
import { callToolText, connectClient } from '../support/mcp-client.ts';
import { createTestRegistry } from '../support/registry.ts';

async function connect(names: string[]) {
  const { registry, fakes } = createTestRegistry(names, { handler: () => [rowsResult([{ answer: 42 }])] });
  const client = await connectClient(createServer(registry));
  return { client, fakes };
}

test('a tool call runs against the pool of the database it names and no other', async () => {
  const { client, fakes } = await connect(['a', 'b']);

  const text = await callToolText(client, 'execute_sql', { database: 'b', sql: 'SELECT 42 AS answer' });

  expect(JSON.parse(text)).toEqual([{ answer: 42 }]);
  expect([...fakes.keys()]).toEqual(['b']);
  expect(fakes.get('b')?.queries.map((query) => query.text)).toContainEqual(expect.stringContaining('SELECT 42'));
});

test('a tool call for an unknown database returns an error naming it', async () => {
  const { client, fakes } = await connect(['a']);

  const text = await callToolText(client, 'execute_sql', { database: 'missing', sql: 'SELECT 1' });

  expect(text).toContain('Error: Unknown database "missing"');
  expect(fakes.size).toBe(0);
});

test('list_databases lists closed databases by name under their source without opening a pool', async () => {
  const { client, fakes } = await connect(['b', 'a']);

  const text = await callToolText(client, 'list_databases');

  expect(JSON.parse(text)).toEqual({ cli: ['a', 'b'] });
  expect(fakes.size).toBe(0);
});

test('list_databases names a discovery server by host and port only, never its credentials or options', async () => {
  const { registry } = createTestRegistry([], {
    handler: ({ text }) => (text.includes('pg_database') ? [rowsResult([{ datname: 'app' }])] : [noRowsResult]),
    servers: [
      {
        uri: { uri: 'postgresql://u:secret@db.example:5433/postgres?sslpassword=x' },
        prefix: 'p-',
        include: ['*'],
        exclude: [],
      },
    ],
  });
  const client = await connectClient(createServer(registry));

  const text = await callToolText(client, 'list_databases');

  expect(JSON.parse(text)).toMatchObject({ servers: [{ server: 'db.example:5433', prefix: 'p-' }] });
  expect(text).not.toContain('secret');
  expect(text).not.toContain('sslpassword');
});

test('a tool call for a database whose environment variable is unset returns the error as text', async () => {
  const { registry } = createTestRegistry([], {
    databases: [{ name: 'app', source: 'cli', uri: { error: 'environment variable MCP_APP_DATABASE_URI is not set' } }],
  });
  const client = await connectClient(createServer(registry));

  const text = await callToolText(client, 'list_schemas', { database: 'app' });

  expect(text).toBe('Error: Database "app": environment variable MCP_APP_DATABASE_URI is not set');
});

test('list_databases shows why the last call could not reach a database, password masked, until a call reaches it', async () => {
  let reachable = false;
  const { registry } = createTestRegistry(['a'], {
    handler: ({ text }) => {
      if (text === 'SELECT 1' && !reachable) {
        throw new Error('could not connect to postgresql://u:p@h:5432/a');
      }
      return [rowsResult([{ answer: 42 }])];
    },
  });
  const client = await connectClient(createServer(registry));
  await callToolText(client, 'execute_sql', { database: 'a', sql: 'SELECT 42 AS answer' });
  expect(JSON.parse(await callToolText(client, 'list_databases'))).toEqual({
    cli: [{ database: 'a', state: 'closed', last_error: 'could not connect to postgresql://u:****@h:5432/a' }],
  });

  reachable = true;
  await callToolText(client, 'execute_sql', { database: 'a', sql: 'SELECT 42 AS answer' });
  await expect(callToolText(client, 'list_databases')).resolves.not.toContain('last_error');
});

test('a connection error stays listed after its pool closes, through a call cancelled before reaching the database', async () => {
  const { registry } = createTestRegistry(['a'], {
    handler: () => {
      throw new Error('connection refused');
    },
  });
  await expect(registry.use('a', (driver) => queryRows(driver, 'SELECT 2'))).rejects.toThrow('connection refused');
  await registry.closeAll();

  await expect(
    registry.use('a', (driver) => queryRows(driver, 'SELECT 2'), { signal: AbortSignal.abort() })
  ).rejects.toThrow('Query cancelled');

  expect((await registry.list()).cli).toMatchObject([{ database: 'a', last_error: 'connection refused' }]);
});

test('execute_sql tells a statement with no result set from a SELECT that returns no rows', async () => {
  const { registry } = createTestRegistry(['a'], {
    handler: ({ text }) => [text.includes('SELECT') ? { rows: [], fields: [{ name: 'a' }] } : noRowsResult],
  });
  const client = await connectClient(createServer(registry));

  const noResultSet = await callToolText(client, 'execute_sql', { database: 'a', sql: 'ANALYZE' });
  const noRows = await callToolText(client, 'execute_sql', { database: 'a', sql: 'SELECT 1 AS a WHERE false' });

  expect(noResultSet).toBe('No results');
  expect(JSON.parse(noRows)).toEqual([]);
});

test('execute_sql keeps every column of a result with duplicate column names, renaming the later ones', async () => {
  const { registry } = createTestRegistry(['a'], {
    handler: ({ text }) => [text.includes('AS a_2') ? arrayRowsResult(['a', 'a', 'a_2'], [[1, 2, 3]]) : noRowsResult],
  });
  const client = await connectClient(createServer(registry));

  const text = await callToolText(client, 'execute_sql', { database: 'a', sql: 'SELECT 1 AS a, 2 AS a, 3 AS a_2' });

  expect(text).toBe('[{"a":1,"a_3":2,"a_2":3}]');
});
