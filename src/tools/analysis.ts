import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { ErrorResult } from '../artifacts.ts';
import { ExplainPlanArtifact } from '../artifacts.ts';
import { DatabaseHealthTool } from '../database-health/database-health.ts';
import { UsageError } from '../errors.ts';
import type { HypotheticalIndex } from '../explain/explain-plan.ts';
import { ExplainPlanTool } from '../explain/explain-plan.ts';
import { DatabaseTuningAdvisor } from '../index/dta-calc.ts';
import { MAX_NUM_INDEX_TUNING_QUERIES } from '../index/index-opt-base.ts';
import type { AdvisorOutput } from '../index/presentation.ts';
import { TextPresentation } from '../index/presentation.ts';
import { toJson } from '../json.ts';
import { requireHypopg } from '../sql/extension-utils.ts';
import type { SqlExecutor } from '../sql/safe-sql.ts';
import { TopQueriesCalc } from '../top-queries/top-queries-calc.ts';
import { formatError, formatTextResponse } from './result.ts';

export async function explainQuery(
  sqlDriver: SqlExecutor,
  sql: string,
  analyze: boolean,
  hypotheticalIndexes: readonly HypotheticalIndex[]
): Promise<CallToolResult> {
  const explainTool = new ExplainPlanTool(sqlDriver);
  let result: ExplainPlanArtifact | ErrorResult;

  // If hypothetical indexes are specified, check for HypoPG extension
  if (hypotheticalIndexes.length > 0) {
    if (analyze) {
      return formatError('Cannot use analyze and hypothetical indexes together');
    }
    await requireHypopg(sqlDriver);
    result = await explainTool.explainWithHypotheticalIndexes(sql, hypotheticalIndexes);
  } else if (analyze) {
    result = await explainTool.explainAnalyze(sql);
  } else {
    result = await explainTool.explain(sql);
  }

  if (result instanceof ExplainPlanArtifact) {
    return formatTextResponse(result.toText());
  }
  return formatError(result);
}

export async function executeSql(sqlDriver: SqlExecutor, sql: string): Promise<CallToolResult> {
  const { columns, rows } = await sqlDriver.executeResultSet(sql);
  if (columns.length === 0) {
    return formatTextResponse('No results');
  }
  return formatTextResponse(toJson(rows));
}

/** The structured result, and the same result as JSON text; the debug trace goes into the text only. */
function advisorResponse({ result, trace }: AdvisorOutput): CallToolResult {
  const text = toJson(trace ? { ...result, _langfuse_trace: trace } : result);
  return { content: [{ type: 'text', text }], structuredContent: result };
}

export async function analyzeWorkloadIndexes(sqlDriver: SqlExecutor, maxIndexSizeMb: number): Promise<CallToolResult> {
  const indexTuning = new DatabaseTuningAdvisor(sqlDriver);
  const dtaTool = new TextPresentation(indexTuning);
  const result = await dtaTool.analyzeWorkload(maxIndexSizeMb);
  return advisorResponse(result);
}

export async function analyzeQueryIndexes(
  sqlDriver: SqlExecutor,
  queries: string[],
  maxIndexSizeMb: number
): Promise<CallToolResult> {
  // Thrown, not returned: every failure of a tool with an outputSchema reaches the handler, which sets isError.
  // TextPresentation.analyzeQueries rejects an empty list.
  if (queries.length > MAX_NUM_INDEX_TUNING_QUERIES) {
    throw new UsageError(`Please provide a list of up to ${MAX_NUM_INDEX_TUNING_QUERIES} queries to analyze.`);
  }

  const indexTuning = new DatabaseTuningAdvisor(sqlDriver);
  const dtaTool = new TextPresentation(indexTuning);
  const result = await dtaTool.analyzeQueries(queries, maxIndexSizeMb);
  return advisorResponse(result);
}

export async function analyzeDbHealth(sqlDriver: SqlExecutor, healthType: string): Promise<CallToolResult> {
  const healthTool = new DatabaseHealthTool(sqlDriver);
  return formatTextResponse(await healthTool.health(healthType));
}

export async function getTopQueries(sqlDriver: SqlExecutor, sortBy: string, limit: number): Promise<CallToolResult> {
  const topQueriesTool = new TopQueriesCalc(sqlDriver);

  if (sortBy === 'resources') {
    return formatTextResponse(await topQueriesTool.getTopResourceQueries());
  }
  if (sortBy === 'mean_time' || sortBy === 'total_time') {
    return formatTextResponse(
      await topQueriesTool.getTopQueriesByTime(limit, sortBy === 'mean_time' ? 'mean' : 'total')
    );
  }
  return formatError("Invalid sort criteria. Please use 'resources' or 'mean_time' or 'total_time'.");
}
