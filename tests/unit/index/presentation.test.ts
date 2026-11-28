import { afterEach, expect, test, vi } from 'vitest';

import { advisorResultSchema } from '../../../src/index/advisor-result.ts';
import { DatabaseTuningAdvisor } from '../../../src/index/dta-calc.ts';
import {
  IndexRecommendation,
  IndexRecommendationAnalysis,
  IndexTuningResult,
} from '../../../src/index/index-opt-base.ts';
import { TextPresentation } from '../../../src/index/presentation.ts';
import { fakeExecutor } from '../../support/fake-executor.ts';

/** A presentation whose advisor finishes with no recommendations and one trace line. */
function presentation(): TextPresentation {
  const driver = fakeExecutor(() => []);
  const tuning = new DatabaseTuningAdvisor(driver);
  vi.spyOn(tuning, 'analyzeWorkload').mockImplementation(() => {
    const session = new IndexTuningResult('1', 10);
    session.dtaTraces = ['trace line'];
    return Promise.resolve(session);
  });
  return new TextPresentation(tuning);
}

/** A presentation whose advisor recommends one index, with the given costs and problem reason. */
function presentationWithRecommendation(baseCost: number, newCost: number, reason: string | null): TextPresentation {
  const driver = fakeExecutor(() => []);
  const tuning = new DatabaseTuningAdvisor(driver);
  const recommendation = new IndexRecommendation('public.t', ['a'], 'btree', 8192, reason);
  vi.spyOn(tuning, 'analyzeWorkload').mockImplementation(() => {
    const session = new IndexTuningResult('1', 10);
    session.recommendations = [
      new IndexRecommendationAnalysis({
        definition: recommendation.definition,
        indexRecommendation: recommendation,
        individualBaseCost: baseCost,
        individualRecommendationCost: newCost,
        progressiveBaseCost: baseCost,
        progressiveRecommendationCost: newCost,
        queries: ['SELECT * FROM t WHERE a = 1'],
      }),
    ];
    return Promise.resolve(session);
  });
  vi.spyOn(tuning, 'getExplainPlanWithIndexes').mockImplementation((_query, indexes) =>
    Promise.resolve({
      Plan: {
        'Node Type': indexes.length > 0 ? 'Index Scan' : 'Seq Scan',
        'Startup Cost': 0,
        'Total Cost': indexes.length > 0 ? newCost : baseCost,
        'Plan Rows': 10,
        'Plan Width': 4,
      },
    })
  );
  return new TextPresentation(tuning);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

test('index recommendations leave out the advisor trace unless it is requested', async () => {
  vi.stubEnv('POSTGRES_MCP_INCLUDE_LANGFUSE_TRACE', undefined);

  const output = await presentation().analyzeQueries(['SELECT 1'], 10_000);

  expect(output.trace).toBeUndefined();
});

test('POSTGRES_MCP_INCLUDE_LANGFUSE_TRACE=true adds the advisor trace to index recommendations', async () => {
  vi.stubEnv('POSTGRES_MCP_INCLUDE_LANGFUSE_TRACE', 'true');

  const output = await presentation().analyzeQueries(['SELECT 1'], 10_000);

  expect(output.trace).toEqual(['trace line']);
});

test('a recommendation reports raw numbers, the size in bytes and a long text warning', async () => {
  const { result } = await presentationWithRecommendation(100, 25, 'long_text_column').analyzeQueries(
    ['SELECT 1'],
    10_000
  );

  const parsed = advisorResultSchema.parse(result);
  expect(parsed.summary).toMatchObject({ total_recommendations: 1, improvement_multiple: 4, total_size_bytes: 8192 });
  expect(parsed.recommendations[0]).toMatchObject({ index_size_bytes: 8192 });
  expect(parsed.recommendations[0]?.warning).toContain('long text column');
  expect(parsed.query_impact[0]).toMatchObject({ base_cost: 100, new_cost: 25, improvement_multiple: 4 });
  expect(parsed.query_impact[0]?.before_explain_plan).toMatch(/^→ Seq Scan/u);
  expect(parsed.query_impact[0]?.after_explain_plan).toMatch(/^→ Index Scan/u);
});

test('a cost that is not finite is reported as null', async () => {
  const { result } = await presentationWithRecommendation(Number.POSITIVE_INFINITY, 25, null).analyzeQueries(
    ['SELECT 1'],
    10_000
  );

  expect(result.summary).toMatchObject({ base_cost: null, new_cost: 25, improvement_multiple: null });
});

test('an infinite new cost has no improvement multiple', async () => {
  const { result } = await presentationWithRecommendation(100, Number.POSITIVE_INFINITY, null).analyzeQueries(
    ['SELECT 1'],
    10_000
  );

  expect(result.summary).toMatchObject({ base_cost: 100, new_cost: null, improvement_multiple: null });
});

test('an index that takes the cost to zero has no improvement multiple, the same in every section', async () => {
  const { result } = await presentationWithRecommendation(100, 0, null).analyzeQueries(['SELECT 1'], 10_000);

  const multiples = [
    result.summary.improvement_multiple,
    result.recommendations[0]?.benefit_of_this_index_only.improvement_multiple,
    result.recommendations[0]?.benefit_after_previous_indexes.improvement_multiple,
    result.query_impact[0]?.improvement_multiple,
  ];
  expect(multiples).toEqual([null, null, null, null]);
});

test('a zero base cost has no improvement multiple', async () => {
  const { result } = await presentationWithRecommendation(0, 25, null).analyzeQueries(['SELECT 1'], 10_000);

  expect(result.summary).toMatchObject({ base_cost: 0, new_cost: 25, improvement_multiple: null });
});

test('a recommendation without a problem reason has no warning, and another reason gets the generic warning', async () => {
  const plain = await presentationWithRecommendation(100, 25, null).analyzeQueries(['SELECT 1'], 10_000);
  const wide = await presentationWithRecommendation(100, 25, 'wide').analyzeQueries(['SELECT 1'], 10_000);

  expect(plain.result.recommendations[0]).not.toHaveProperty('warning');
  expect(wide.result.recommendations[0]?.warning).toBe(
    'This index is potentially problematic because it includes a wide column.'
  );
});

test('a plan that cannot be read is reported as null plan text', async () => {
  const unreadable = presentationWithRecommendation(100, 25, null);
  vi.spyOn(unreadable.indexTuning, 'getExplainPlanWithIndexes').mockResolvedValue({});

  const { result } = await unreadable.analyzeQueries(['SELECT 1'], 10_000);

  expect(advisorResultSchema.parse(result).query_impact[0]).toMatchObject({
    before_explain_plan: null,
    after_explain_plan: null,
    explain_plan_diff: null,
  });
});
