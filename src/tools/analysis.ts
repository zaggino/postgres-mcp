import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { ErrorResult } from '../artifacts.ts';
import { ExplainPlanArtifact } from '../artifacts.ts';
import { DatabaseHealthTool } from '../database-health/database-health.ts';
import { ExplainPlanTool } from '../explain/explain-plan.ts';
import { DatabaseTuningAdvisor } from '../index/dta-calc.ts';
import { MAX_NUM_INDEX_TUNING_QUERIES } from '../index/index-opt-base.ts';
import { TextPresentation } from '../index/presentation.ts';
import { checkHypopgInstallationStatus } from '../sql/extension-utils.ts';
import type { SqlExecutor } from '../sql/safe-sql.ts';
import { TopQueriesCalc } from '../top-queries/top-queries-calc.ts';
import { formatError, formatTextResponse, toJson } from './result.ts';

export async function explainQuery(
  sqlDriver: SqlExecutor,
  sql: string,
  analyze: boolean,
  hypotheticalIndexes: Record<string, unknown>[]
): Promise<CallToolResult> {
  const explainTool = new ExplainPlanTool(sqlDriver);
  let result: ExplainPlanArtifact | ErrorResult;

  // If hypothetical indexes are specified, check for HypoPG extension
  if (hypotheticalIndexes.length > 0) {
    if (analyze) {
      return formatError('Cannot use analyze and hypothetical indexes together');
    }
    const [isHypopgInstalled, hypopgMessage] = await checkHypopgInstallationStatus(sqlDriver);

    // If hypopg is not installed, return the message
    if (!isHypopgInstalled) {
      return formatTextResponse(hypopgMessage);
    }

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
  const rows = await sqlDriver.executeQuery(sql);
  if (rows === null) {
    return formatTextResponse('No results');
  }
  return formatTextResponse(toJson(rows.map((r) => r.cells)));
}

export async function analyzeWorkloadIndexes(sqlDriver: SqlExecutor, maxIndexSizeMb: number): Promise<CallToolResult> {
  const indexTuning = new DatabaseTuningAdvisor(sqlDriver);
  const dtaTool = new TextPresentation(sqlDriver, indexTuning);
  const result = await dtaTool.analyzeWorkload(maxIndexSizeMb);
  return formatTextResponse(toJson(result));
}

export async function analyzeQueryIndexes(
  sqlDriver: SqlExecutor,
  queries: string[],
  maxIndexSizeMb: number
): Promise<CallToolResult> {
  if (queries.length === 0) {
    return formatError('Please provide a non-empty list of queries to analyze.');
  }
  if (queries.length > MAX_NUM_INDEX_TUNING_QUERIES) {
    return formatError(`Please provide a list of up to ${MAX_NUM_INDEX_TUNING_QUERIES} queries to analyze.`);
  }

  const indexTuning = new DatabaseTuningAdvisor(sqlDriver);
  const dtaTool = new TextPresentation(sqlDriver, indexTuning);
  const result = await dtaTool.analyzeQueries(queries, maxIndexSizeMb);
  return formatTextResponse(toJson(result));
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
