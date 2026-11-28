import { afterEach, expect, test, vi } from 'vitest';

import { DatabaseTuningAdvisor } from '../../../src/index/dta-calc.ts';
import { IndexTuningResult } from '../../../src/index/index-opt-base.ts';
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
