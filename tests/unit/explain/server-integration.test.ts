import { afterEach, beforeEach, expect, it as test, vi } from 'vitest';

import { ExplainPlanArtifact } from '../../../src/artifacts.ts';
import { AccessMode, createServer, deps } from '../../../src/server.ts';
import type { SqlExecutor } from '../../../src/sql/safe-sql.ts';
import { callToolText, connectClient } from '../../support/mcp-client.ts';

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

type ExecuteQuery = SqlExecutor['executeQuery'];

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

function useDriver(executeQuery: ExecuteQuery = vi.fn<ExecuteQuery>()) {
  vi.spyOn(deps, 'getSqlDriver').mockReturnValue({ executeQuery });
}

async function explainQuery(args: Record<string, unknown>): Promise<string> {
  const client = await connectClient(createServer(AccessMode.UNRESTRICTED));
  return callToolText(client, 'explain_query', args);
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
  useDriver(vi.fn<ExecuteQuery>().mockResolvedValue([{ cells: { exists: 1 } }]));
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
  useDriver(vi.fn<ExecuteQuery>().mockResolvedValue([]));

  const text = await explainQuery({
    sql: "SELECT * FROM users WHERE email = 'test@example.com'",
    hypothetical_indexes: [{ table: 'users', columns: ['email'] }],
  });

  expect(text).toContain('CREATE EXTENSION hypopg;');
  expect(explainTool.explainWithHypotheticalIndexes).not.toHaveBeenCalled();
});

test('explain_query returns the error text when the driver cannot be created', async () => {
  vi.spyOn(deps, 'getSqlDriver').mockImplementation(() => {
    throw new Error('Error executing query');
  });

  const text = await explainQuery({ sql: 'INVALID SQL' });

  expect(text).toBe('Error: Error executing query');
});
