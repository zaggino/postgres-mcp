import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorResult, ExplainPlanArtifact } from '../../../src/artifacts.ts';
import { ExplainPlanTool } from '../../../src/explain/explain-plan.ts';
import { resetPostgresVersionCache } from '../../../src/sql/extension-utils.ts';
import type { Row, SqlExecutor } from '../../../src/sql/safe-sql.ts';
import { fakeExecutor } from '../../support/fake-executor.ts';

const bindParams = vi.hoisted(() => ({ replacement: '' }));

vi.mock('../../../src/sql/bind-params.ts', () => ({
  SqlBindParams: class {
    readonly replacement = bindParams.replacement;
    replaceParameters(): Promise<string> {
      return Promise.resolve(this.replacement);
    }
  },
}));

type ExecuteQuery = SqlExecutor['executeQuery'];

function cell(data: Row): Row[] {
  return [data];
}

function createDriver(): {
  driver: SqlExecutor;
  executeQuery: ReturnType<typeof vi.fn<ExecuteQuery>>;
} {
  const driver = fakeExecutor(() => []);
  return { driver, executeQuery: driver.executeQuery };
}

function queries(executeQuery: ReturnType<typeof vi.fn<ExecuteQuery>>) {
  return executeQuery.mock.calls.map(([query]) => query);
}

const seqScanPlan = {
  Plan: {
    'Node Type': 'Seq Scan',
    'Relation Name': 'users',
    'Startup Cost': 0,
    'Total Cost': 10,
    'Plan Rows': 100,
    'Plan Width': 20,
  },
};

const analyzedPlan = {
  Plan: {
    ...seqScanPlan.Plan,
    'Actual Startup Time': 0.01,
    'Actual Total Time': 1.23,
    'Actual Rows': 95,
    'Actual Loops': 1,
  },
  'Planning Time': 0.05,
  'Execution Time': 1.3,
};

beforeEach(() => {
  resetPostgresVersionCache();
});

describe(ExplainPlanTool, () => {
  it('keeps the driver it was created with', () => {
    const { driver } = createDriver();
    expect(new ExplainPlanTool(driver).sqlDriver).toBe(driver);
  });

  it('detects bind variables', () => {
    expect(ExplainPlanTool.hasBindVariables('SELECT * FROM users WHERE id = $1')).toBe(true);
    expect(ExplainPlanTool.hasBindVariables('INSERT INTO users VALUES ($1, $2)')).toBe(true);
    expect(ExplainPlanTool.hasBindVariables('SELECT * FROM users WHERE id = 1')).toBe(false);
    expect(ExplainPlanTool.hasBindVariables("INSERT INTO users VALUES (1, 'test')")).toBe(false);
  });

  it('detects LIKE expressions case-insensitively', () => {
    expect(ExplainPlanTool.hasLikeExpressions("SELECT * FROM users WHERE name LIKE '%John%'")).toBe(true);
    expect(ExplainPlanTool.hasLikeExpressions("SELECT * FROM users WHERE name like 'John%'")).toBe(true);
    expect(ExplainPlanTool.hasLikeExpressions("SELECT * FROM users WHERE UPPER(name) LIKE 'JOHN%'")).toBe(true);
    expect(ExplainPlanTool.hasLikeExpressions("SELECT * FROM users WHERE name = 'John'")).toBe(false);
    expect(ExplainPlanTool.hasLikeExpressions('SELECT * FROM users WHERE id > 100')).toBe(false);
  });

  it('explains a query without bind variables using plain FORMAT JSON', async () => {
    const { driver, executeQuery } = createDriver();
    executeQuery.mockResolvedValue(cell({ 'QUERY PLAN': [seqScanPlan] }));

    const result = await new ExplainPlanTool(driver).explain('SELECT * FROM users');

    expect(executeQuery).toHaveBeenCalledOnce();
    expect(queries(executeQuery)[0]).toContain('EXPLAIN (FORMAT JSON) SELECT * FROM users');
    expect(result).toBeInstanceOf(ExplainPlanArtifact);
    expect(result).toMatchObject({
      value: JSON.stringify(seqScanPlan, null, 2),
    });
  });

  it('uses GENERIC_PLAN for bind variables on PostgreSQL 16', async () => {
    const { driver, executeQuery } = createDriver();
    executeQuery.mockImplementation((query) =>
      Promise.resolve(
        query === 'SHOW server_version' ? cell({ server_version: '16.0' }) : cell({ 'QUERY PLAN': [seqScanPlan] })
      )
    );

    const result = await new ExplainPlanTool(driver).explain('SELECT * FROM users WHERE id = $1');

    expect(result).toBeInstanceOf(ExplainPlanArtifact);
    const explainCall = queries(executeQuery).find((q) => q.includes('EXPLAIN'));
    expect(explainCall).toContain('EXPLAIN (FORMAT JSON, GENERIC_PLAN) SELECT * FROM users WHERE id = $1');
  });

  it('replaces bind variables instead of using GENERIC_PLAN on PostgreSQL 15', async () => {
    bindParams.replacement = 'SELECT * FROM users WHERE id = 42';
    const { driver, executeQuery } = createDriver();
    executeQuery.mockImplementation((query) => {
      if (query === 'SHOW server_version') {
        return Promise.resolve(cell({ server_version: '15.4' }));
      }
      if (query.includes('EXPLAIN') && query.includes('id = 42')) {
        return Promise.resolve(cell({ 'QUERY PLAN': [seqScanPlan] }));
      }
      return Promise.resolve([]);
    });

    const result = await new ExplainPlanTool(driver).explain('SELECT * FROM users WHERE id = $1');

    expect(result).toBeInstanceOf(ExplainPlanArtifact);
    const sent = queries(executeQuery);
    expect(sent.some((q) => q.includes('server_version'))).toBe(true);
    const explainCall = sent.find((q) => q.includes('EXPLAIN'));
    expect(explainCall).toBeDefined();
    expect(explainCall).not.toContain('GENERIC_PLAN');
    expect(explainCall).toContain('id = 42');
  });

  it('explain analyze with bind variables uses parameter replacement', async () => {
    bindParams.replacement = 'SELECT * FROM users WHERE id = 42';
    const { driver, executeQuery } = createDriver();
    executeQuery.mockImplementation((query) =>
      Promise.resolve(
        query.includes('EXPLAIN') && query.includes('id = 42') ? cell({ 'QUERY PLAN': [analyzedPlan] }) : []
      )
    );

    const result = await new ExplainPlanTool(driver).explainAnalyze('SELECT * FROM users WHERE id = $1');

    expect(result).toBeInstanceOf(ExplainPlanArtifact);
    const lastQuery = queries(executeQuery).at(-1);
    expect(lastQuery).toContain('ANALYZE');
    expect(lastQuery).not.toContain('GENERIC_PLAN');
    expect(lastQuery).toContain('id = 42');
  });

  it('explain analyze sends FORMAT JSON, ANALYZE and returns the plan', async () => {
    const { driver, executeQuery } = createDriver();
    executeQuery.mockResolvedValue(cell({ 'QUERY PLAN': [analyzedPlan] }));

    const result = await new ExplainPlanTool(driver).explainAnalyze('SELECT * FROM users');

    expect(queries(executeQuery).at(-1)).toContain('EXPLAIN (FORMAT JSON, ANALYZE) SELECT * FROM users');
    expect(result).toBeInstanceOf(ExplainPlanArtifact);
    expect(result).toMatchObject({
      value: JSON.stringify(analyzedPlan, null, 2),
    });
  });

  it('returns an error result when the database fails', async () => {
    const { driver, executeQuery } = createDriver();
    executeQuery.mockRejectedValue(new Error('Database error'));

    const result = await new ExplainPlanTool(driver).explain('SELECT * FROM users');

    expect(result).toBeInstanceOf(ErrorResult);
    expect(result).toHaveProperty('value', expect.stringContaining('Database error'));
  });

  it('rejects a QUERY PLAN that is not a list', async () => {
    const { driver, executeQuery } = createDriver();
    executeQuery.mockResolvedValue(cell({ 'QUERY PLAN': 'invalid' }));

    const result = await new ExplainPlanTool(driver).explain('SELECT * FROM users');

    expect(result).toBeInstanceOf(ErrorResult);
    expect(result).toHaveProperty('value', expect.stringContaining('Expected list'));
  });

  it('reports no results when EXPLAIN returns no rows', async () => {
    const { driver, executeQuery } = createDriver();
    executeQuery.mockResolvedValue([]);

    const result = await new ExplainPlanTool(driver).explain('SELECT * FROM users');

    expect(result).toBeInstanceOf(ErrorResult);
    expect(result).toHaveProperty('value', 'No results returned from EXPLAIN');
  });

  it('reports no results when QUERY PLAN is an empty list', async () => {
    const { driver, executeQuery } = createDriver();
    executeQuery.mockResolvedValue(cell({ 'QUERY PLAN': [] }));

    const result = await new ExplainPlanTool(driver).explain('SELECT * FROM users');

    expect(result).toBeInstanceOf(ErrorResult);
    expect(result).toHaveProperty('value', expect.stringContaining('No results'));
  });

  it('replaces bind variables for LIKE queries even on PostgreSQL 16', async () => {
    bindParams.replacement = "SELECT * FROM users WHERE name LIKE '%John%'";
    const { driver, executeQuery } = createDriver();
    executeQuery.mockImplementation((query) => {
      if (query === 'SHOW server_version') {
        return Promise.resolve(cell({ server_version: '16.0' }));
      }
      if (query.includes('EXPLAIN') && query.includes("LIKE '%John%'")) {
        return Promise.resolve(cell({ 'QUERY PLAN': [seqScanPlan] }));
      }
      return Promise.resolve([]);
    });

    const result = await new ExplainPlanTool(driver).explain('SELECT * FROM users WHERE name LIKE $1');

    expect(result).toBeInstanceOf(ExplainPlanArtifact);
    const sent = queries(executeQuery);
    expect(sent.some((q) => q.includes('server_version'))).toBe(true);
    const explainCall = sent.find((q) => q.includes('EXPLAIN'));
    expect(explainCall).toBeDefined();
    expect(explainCall).not.toContain('GENERIC_PLAN');
    expect(explainCall).toContain("LIKE '%John%'");
  });

  it('creates functional hypothetical indexes in a single EXPLAIN batch', async () => {
    const indexPlan = {
      Plan: {
        'Node Type': 'Index Scan',
        'Index Name': 'hypothetical_idx',
        'Relation Name': 'title_basics',
        'Startup Cost': 0,
        'Total Cost': 100,
        'Plan Rows': 100,
        'Plan Width': 20,
      },
    };
    const { driver, executeQuery } = createDriver();
    executeQuery.mockImplementation((query) =>
      Promise.resolve(query.includes('hypopg_') || query.includes('EXPLAIN') ? cell({ 'QUERY PLAN': [indexPlan] }) : [])
    );

    const sqlQuery = `
    SELECT * FROM title_basics
    WHERE primary_title ILIKE '%star%' OR original_title ILIKE '%star%'
    ORDER BY start_year DESC
    LIMIT 20 OFFSET 0;
    `;

    const result = await new ExplainPlanTool(driver).explainWithHypotheticalIndexes(sqlQuery, [
      { table: 'title_basics', columns: ['LOWER(primary_title)'] },
      { table: 'title_basics', columns: ['LOWER(original_title)'] },
      { table: 'title_basics', columns: ['start_year DESC'] },
    ]);

    expect(result).toBeInstanceOf(ExplainPlanArtifact);
    const explainCalls = queries(executeQuery).filter((q) => q.includes('EXPLAIN'));
    expect(explainCalls).toHaveLength(1);
    const [explainCall] = explainCalls;
    expect(explainCall).toContain('SELECT hypopg_reset();');
    expect(explainCall).toContain('hypopg_create_index');
    expect(explainCall).toContain('LOWER(primary_title)');
    expect(explainCall).toContain('LOWER(original_title)');
    expect(explainCall).toContain('start_year DESC');
  });
});
