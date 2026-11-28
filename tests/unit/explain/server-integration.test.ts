import { afterEach, beforeEach, expect, it as test, vi } from 'vitest';

import { ExplainPlanArtifact } from '../../../src/artifacts.ts';
import type { RegistryOptions } from '../../../src/database-registry.ts';
import { createServer } from '../../../src/server.ts';
import type { SqlExecutor } from '../../../src/sql/safe-sql.ts';
import { fakeExecutor } from '../../support/fake-executor.ts';
import { callToolText, connectClient } from '../../support/mcp-client.ts';
import { createTestRegistry } from '../../support/registry.ts';

const explainTool = vi.hoisted(() => ({
  explain: vi.fn(),
  explainAnalyze: vi.fn(),
  explainWithHypotheticalIndexes: vi.fn(),
}));

vi.mock('../../../src/explain/explain-plan.ts', () => ({
  ExplainPlanTool: class {
    explain = explainTool.explain;
    explainAnalyze = explainTool.explainAnalyze;
    explainWithHypotheticalIndexes = explainTool.explainWithHypotheticalIndexes;
  },
}));

/** The driver factory the next server's registry uses; the real one when unset. */
let getSqlDriver: RegistryOptions['getSqlDriver'];

function artifact(extra: Record<string, unknown> = {}): ExplainPlanArtifact {
  return ExplainPlanArtifact.fromJsonData({
    Plan: {
      'Node Type': 'Seq Scan',
      'Total Cost': 10,
      'Startup Cost': 0,
      'Plan Rows': 5,
      'Plan Width': 4,
    },
    ...extra,
  });
}

function useDriver(driver: SqlExecutor = fakeExecutor(() => [])) {
  getSqlDriver = () => driver;
}

async function explainQuery(args: Record<string, unknown>): Promise<string> {
  const client = await connectClient(createServer(createTestRegistry(['app'], { getSqlDriver }).registry));
  return await callToolText(client, 'explain_query', { database: 'app', ...args });
}

beforeEach(() => {
  useDriver();
});

afterEach(() => {
  vi.restoreAllMocks();
  explainTool.explain.mockReset();
  explainTool.explainAnalyze.mockReset();
  explainTool.explainWithHypotheticalIndexes.mockReset();
});

test('explain_query returns the text of the plan from a basic EXPLAIN', async () => {
  explainTool.explain.mockResolvedValue(artifact());

  const text = await explainQuery({ sql: 'SELECT * FROM users' });

  expect(text).toContain('Seq Scan');
  expect(explainTool.explain).toHaveBeenCalledWith('SELECT * FROM users');
});

test('explain_query with analyze=true returns the plan with execution time', async () => {
  explainTool.explainAnalyze.mockResolvedValue(artifact({ 'Execution Time': 1.23 }));

  const text = await explainQuery({
    sql: 'SELECT * FROM users',
    analyze: true,
  });

  expect(text).toContain('Execution Time: 1.230 ms');
  expect(explainTool.explain).not.toHaveBeenCalled();
});

test('explain_query with hypothetical indexes explains with them when hypopg is installed', async () => {
  useDriver(fakeExecutor(() => [{ exists: 1 }]));
  explainTool.explainWithHypotheticalIndexes.mockResolvedValue(artifact());
  const indexes = [{ table: 'users', columns: ['email'] }];

  const text = await explainQuery({
    sql: "SELECT * FROM users WHERE email = 'test@example.com'",
    hypothetical_indexes: indexes,
  });

  expect(text).toContain('Seq Scan');
  expect(explainTool.explainWithHypotheticalIndexes).toHaveBeenCalledWith(
    "SELECT * FROM users WHERE email = 'test@example.com'",
    indexes
  );
});

test('explain_query with hypothetical indexes reports a missing hypopg extension', async () => {
  useDriver(fakeExecutor(() => []));

  const text = await explainQuery({
    sql: "SELECT * FROM users WHERE email = 'test@example.com'",
    hypothetical_indexes: [{ table: 'users', columns: ['email'] }],
  });

  expect(text).toContain('CREATE EXTENSION hypopg;');
  expect(explainTool.explainWithHypotheticalIndexes).not.toHaveBeenCalled();
});

test('explain_query returns the error text when the driver cannot be created', async () => {
  getSqlDriver = () => {
    throw new Error('Error executing query');
  };

  const text = await explainQuery({ sql: 'INVALID SQL' });

  expect(text).toBe('Error: Error executing query');
});
