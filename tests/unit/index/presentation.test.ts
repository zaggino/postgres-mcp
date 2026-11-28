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
  return new TextPresentation(driver, tuning);
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
    Promise.resolve({ Plan: { 'Node Type': 'Seq Scan', 'Total Cost': indexes.length > 0 ? newCost : baseCost } })
  );
  return new TextPresentation(driver, tuning);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

test('index recommendations leave out the advisor trace unless it is requested', async () => {
  vi.stubEnv('POSTGRES_MCP_INCLUDE_LANGFUSE_TRACE', undefined);

  const result = await presentation().analyzeQueries(['SELECT 1']);

  expect(result).not.toHaveProperty('_langfuse_trace');
});

test('POSTGRES_MCP_INCLUDE_LANGFUSE_TRACE=true adds the advisor trace to index recommendations', async () => {
  vi.stubEnv('POSTGRES_MCP_INCLUDE_LANGFUSE_TRACE', 'true');

  const result = await presentation().analyzeQueries(['SELECT 1']);

  expect(result).toHaveProperty('_langfuse_trace', ['trace line']);
});

test('no recommendations give an empty result that matches the schema', async () => {
  const result = await presentation().analyzeQueries(['SELECT 1']);

  expect(advisorResultSchema.parse(result)).toEqual({
    summary: {
      total_recommendations: 0,
      base_cost: null,
      new_cost: null,
      improvement_multiple: null,
      total_size_bytes: 0,
    },
    recommendations: [],
    query_impact: [],
  });
});

test('a recommendation reports raw numbers, the size in bytes and a long text warning', async () => {
  const result = await presentationWithRecommendation(100, 25, 'long_text_column').analyzeQueries(['SELECT 1']);

  const parsed = advisorResultSchema.parse(result);
  expect(parsed.summary).toMatchObject({ total_recommendations: 1, improvement_multiple: 4, total_size_bytes: 8192 });
  expect(parsed.recommendations[0]).toMatchObject({ index_size_bytes: 8192 });
  expect(parsed.recommendations[0]?.warning).toContain('long text column');
  expect(parsed.query_impact[0]).toMatchObject({ base_cost: 100, new_cost: 25, improvement_multiple: 4 });
});

test('a cost that is not finite is reported as null', async () => {
  const result = await presentationWithRecommendation(Number.POSITIVE_INFINITY, 25, null).analyzeQueries(['SELECT 1']);

  expect(result.summary.base_cost).toBeNull();
});
