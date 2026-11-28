import { afterEach, expect, it as test, vi } from 'vitest';

import type { RegistryOptions } from '../../../src/database-registry.ts';
import { createServer } from '../../../src/server.ts';
import { fakeExecutor } from '../../support/fake-executor.ts';
import { callToolText, connectClient } from '../../support/mcp-client.ts';
import { createTestRegistry } from '../../support/registry.ts';

const EXECUTION_ERROR = /^Error: .*Error executing query/u;

/** The driver factory the next server's registry uses; the real one when unset. */
let getSqlDriver: RegistryOptions['getSqlDriver'];

function plan(extra: Record<string, unknown> = {}, node = {}) {
  return {
    Plan: {
      'Node Type': 'Seq Scan',
      'Total Cost': 10,
      'Startup Cost': 0,
      'Plan Rows': 5,
      'Plan Width': 4,
      ...node,
    },
    ...extra,
  };
}

/** A driver that answers EXPLAIN with `planData` and reports hypopg installed. */
function useExplainDriver(planData: unknown) {
  const driver = fakeExecutor((query) =>
    query.includes('pg_extension') ? [{ extversion: '1.4.1' }] : [{ 'QUERY PLAN': [planData] }]
  );
  getSqlDriver = () => driver;
  return driver.executeResultSet;
}

async function explainQuery(args: Record<string, unknown>): Promise<string> {
  const client = await connectClient(createServer(createTestRegistry(['app'], { getSqlDriver }).registry));
  return await callToolText(client, 'explain_query', { database: 'app', ...args });
}

afterEach(() => {
  getSqlDriver = undefined;
  vi.restoreAllMocks();
});

test('registers the explain_query tool', async () => {
  const client = await connectClient(createServer(createTestRegistry(['app'], { getSqlDriver }).registry));

  const { tools } = await client.listTools();

  expect(tools.map((tool) => tool.name)).toContain('explain_query');
});

test('explain_query runs a plain EXPLAIN and returns the plan', async () => {
  const executeResultSet = useExplainDriver(plan());

  const text = await explainQuery({ sql: 'SELECT * FROM users' });

  expect(text).toContain('Seq Scan');
  expect(executeResultSet).toHaveBeenCalledWith('EXPLAIN (FORMAT JSON) SELECT * FROM users');
});

test('explain_query with analyze=true runs EXPLAIN ANALYZE and reports execution time', async () => {
  const executeResultSet = useExplainDriver(plan({ 'Execution Time': 1.3 }, { 'Actual Rows': 100 }));

  const text = await explainQuery({
    sql: 'SELECT * FROM users',
    analyze: true,
  });

  expect(executeResultSet).toHaveBeenCalledWith('EXPLAIN (FORMAT JSON, ANALYZE) SELECT * FROM users');
  expect(text).toContain('Execution Time: 1.300 ms');
});

test('explain_query with hypothetical indexes creates them before explaining', async () => {
  const executeResultSet = useExplainDriver(plan({}, { 'Node Type': 'Index Scan' }));

  const text = await explainQuery({
    sql: "SELECT * FROM users WHERE email = 'test@example.com'",
    hypothetical_indexes: [{ table: 'users', columns: ['email'] }],
  });

  expect(text).toContain('Index Scan');
  expect(executeResultSet.mock.calls.map(([query]) => query).join('\n')).toContain('hypopg_create_index');
});

test('explain_query treats null hypothetical indexes as none and runs a plain EXPLAIN', async () => {
  const executeResultSet = useExplainDriver(plan());

  const text = await explainQuery({ sql: 'SELECT * FROM users', hypothetical_indexes: null });

  expect(text).toContain('Seq Scan');
  expect(executeResultSet).toHaveBeenCalledWith('EXPLAIN (FORMAT JSON) SELECT * FROM users');
});

test('explain_query creates each hypothetical index with its method, btree when none is given', async () => {
  const executeResultSet = useExplainDriver(plan({}, { 'Node Type': 'Index Scan' }));

  await explainQuery({
    sql: "SELECT * FROM users WHERE email = 'a'",
    hypothetical_indexes: [
      { table: 'users', columns: ['email'], using: 'hash' },
      { table: 'users', columns: ['name'] },
    ],
  });

  const sent = executeResultSet.mock.calls.map(([query]) => query).join('\n');
  expect(sent).toContain('ON users USING hash (email)');
  expect(sent).toContain('ON users USING btree (name)');
});

test.each([
  ['columns is a string', { table: 'users', columns: 'email' }],
  ['columns is empty', { table: 'users', columns: [] }],
  ['it has an unknown key', { table: 'users', columns: ['email'], unique: true }],
])('explain_query rejects a hypothetical index when %s, without querying', async (_case, index) => {
  const executeResultSet = useExplainDriver(plan());

  const text = await explainQuery({ sql: 'SELECT * FROM users', hypothetical_indexes: [index] });

  expect(text).toContain('hypothetical_indexes');
  expect(executeResultSet).not.toHaveBeenCalled();
});

test('explain_query rejects analyze combined with hypothetical indexes', async () => {
  useExplainDriver(plan());

  const text = await explainQuery({
    sql: 'SELECT 1',
    analyze: true,
    hypothetical_indexes: [{ table: 'users', columns: ['email'] }],
  });

  expect(text).toBe('Error: Cannot use analyze and hypothetical indexes together');
});

test('explain_query formats a failing EXPLAIN as an error message', async () => {
  getSqlDriver = () =>
    fakeExecutor(() => {
      throw new Error('Error executing query');
    });

  const text = await explainQuery({ sql: 'INVALID SQL' });

  expect(text).toMatch(EXECUTION_ERROR);
});
