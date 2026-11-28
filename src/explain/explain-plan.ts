import { ErrorResult, ExplainPlanArtifact } from '../artifacts.ts';
import { errorMessage } from '../errors.ts';
import { isJsonObject } from '../json.ts';
import { logLine } from '../log.ts';
import { pyTypeName } from '../py-format.ts';
import { SqlBindParams } from '../sql/bind-params.ts';
import * as cell from '../sql/cells.ts';
import { checkPostgresVersionRequirement } from '../sql/extension-utils.ts';
import { IndexDefinition } from '../sql/index-definition.ts';
import type { SqlExecutor } from '../sql/safe-sql.ts';
import { SafeSqlDriver, queryRows } from '../sql/safe-sql.ts';
import type { Row } from '../sql/sql-driver.ts';

const BIND_VARIABLE_PATTERN = /\$\d+/u;
const LIKE_PATTERN = /\bLIKE\b/iu;

/** The part of the index advisor the explain tool needs for trace logging. */
export interface DtaTracer {
  dtaTrace: (message: string) => void;
}

/**
 * The plan as plain JSON values. The pool parses json losslessly, so every cost and row count arrives as a raw JSON
 * value; plan readers do arithmetic and need doubles, so the plan is re-parsed with plain JSON.parse. Text a driver
 * hands over is parsed directly and kept as it is when it is not JSON.
 */
function parsePlanColumn(value: unknown): unknown {
  if (typeof value !== 'string') {
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- not a clone: the round trip turns raw JSON numbers into doubles, structuredClone would copy them as they are
    return JSON.parse(JSON.stringify(value)) as unknown;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** The parsed `QUERY PLAN` of an EXPLAIN result, or undefined when it returned no row. */
function queryPlan(rows: readonly Row[]): unknown {
  const [row] = rows;
  return row ? parsePlanColumn(cell.value(row, 'QUERY PLAN')) : undefined;
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isJsonObject(value)) {
    return Object.keys(value).length > 0;
  }
  return Boolean(value);
}

/** A hypothetical index to simulate, as validated by the `explain_query` input schema. */
export interface HypotheticalIndex {
  table: string;
  columns: readonly string[];
  using?: string;
}

/** Tool for generating and analyzing PostgreSQL explain plans. */
export class ExplainPlanTool {
  readonly sqlDriver: SqlExecutor;

  constructor(sqlDriver: SqlExecutor) {
    this.sqlDriver = sqlDriver;
  }

  /** Replace bind variables with sample values in a query when needed. */
  async replaceQueryParametersIfNeeded(sqlQuery: string): Promise<[string, boolean]> {
    let useGenericPlan = false;
    let query = sqlQuery;

    // If query has bind variables, check PostgreSQL version for generic plan support
    if (ExplainPlanTool.hasBindVariables(query)) {
      const hasLike = ExplainPlanTool.hasLikeExpressions(query);

      const [meetsPgVersionRequirement] = await checkPostgresVersionRequirement(
        this.sqlDriver,
        16,
        'Generic plan with bind variables ($1, $2, etc.)'
      );

      // PostgreSQL < 16, or LIKE expressions (which don't work with GENERIC_PLAN)
      if (!meetsPgVersionRequirement || hasLike) {
        const bindParams = new SqlBindParams(this.sqlDriver);
        query = await bindParams.replaceParameters(query);
      } else {
        useGenericPlan = true;
      }
    }

    return [query, useGenericPlan];
  }

  /** Generate an EXPLAIN plan for a SQL query. */
  async explain(sqlQuery: string, doAnalyze = false): Promise<ExplainPlanArtifact | ErrorResult> {
    const [modifiedSqlQuery, useGenericPlan] = await this.replaceQueryParametersIfNeeded(sqlQuery);
    return await this.runExplainQuery(modifiedSqlQuery, doAnalyze, useGenericPlan);
  }

  /** Generate an EXPLAIN ANALYZE plan for a SQL query. */
  explainAnalyze(sqlQuery: string): Promise<ExplainPlanArtifact | ErrorResult> {
    return this.explain(sqlQuery, true);
  }

  /** Generate an explain plan for a query as if certain indexes existed. */
  async explainWithHypotheticalIndexes(
    sqlQuery: string,
    hypotheticalIndexes: readonly HypotheticalIndex[]
  ): Promise<ExplainPlanArtifact | ErrorResult> {
    try {
      const indexes = new Map<string, IndexDefinition>();
      for (const { table, columns, using } of hypotheticalIndexes) {
        const definition = new IndexDefinition(table, columns, using);
        indexes.set(definition.key, definition);
      }

      // Check if the query contains bind variables
      const [modifiedSqlQuery, useGenericPlan] = await this.replaceQueryParametersIfNeeded(sqlQuery);

      const planData = await this.generateExplainPlanWithHypotheticalIndexes(
        modifiedSqlQuery,
        [...indexes.values()],
        useGenericPlan
      );

      // Check if we got a valid plan
      if (!(isJsonObject(planData) && 'Plan' in planData)) {
        return new ErrorResult('Failed to generate a valid explain plan with the hypothetical indexes');
      }

      try {
        return ExplainPlanArtifact.fromJsonData(planData);
      } catch (error) {
        return new ErrorResult(`Error converting explain plan: ${errorMessage(error)}`);
      }
    } catch (error) {
      logLine(`Error in explain_with_hypothetical_indexes: ${errorMessage(error)}`);
      return new ErrorResult(`Error generating explain plan with hypothetical indexes: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }

  /** Check if a query contains bind variables ($1, $2, etc). */
  static hasBindVariables(query: string): boolean {
    return BIND_VARIABLE_PATTERN.test(query);
  }

  /** Check if a query contains LIKE expressions, which don't work with GENERIC_PLAN. */
  static hasLikeExpressions(query: string): boolean {
    return LIKE_PATTERN.test(query);
  }

  private async runExplainQuery(
    query: string,
    analyze: boolean,
    genericPlan: boolean
  ): Promise<ExplainPlanArtifact | ErrorResult> {
    try {
      const explainOptions = ['FORMAT JSON'];
      if (analyze) {
        explainOptions.push('ANALYZE');
      }
      if (genericPlan) {
        explainOptions.push('GENERIC_PLAN');
      }

      const explainQ = `EXPLAIN (${explainOptions.join(', ')}) ${query}`;
      const rows = await queryRows(this.sqlDriver, explainQ);
      const queryPlanData = queryPlan(rows);
      if (queryPlanData === undefined) {
        return new ErrorResult('No results returned from EXPLAIN');
      }
      if (!Array.isArray(queryPlanData)) {
        return new ErrorResult(`Expected list from EXPLAIN, got ${pyTypeName(queryPlanData)}`);
      }
      if (queryPlanData.length === 0) {
        return new ErrorResult('No results returned from EXPLAIN');
      }

      const planDict: unknown = queryPlanData[0];
      if (!isJsonObject(planDict)) {
        return new ErrorResult(
          `Expected dict in EXPLAIN result list, got ${pyTypeName(planDict)} with value ${String(planDict)}`
        );
      }

      try {
        return ExplainPlanArtifact.fromJsonData(planDict);
      } catch (error) {
        return new ErrorResult(`Internal error converting explain plan - do not retry: ${errorMessage(error)}`);
      }
    } catch (error) {
      return new ErrorResult(`Error executing explain plan: ${errorMessage(error)}`, { cause: error });
    }
  }

  /** Generate an explain plan for a query with the specified indexes enabled. */
  async generateExplainPlanWithHypotheticalIndexes(
    queryText: string,
    indexes: readonly IndexDefinition[],
    useGenericPlan = false,
    dta?: DtaTracer
  ): Promise<unknown> {
    try {
      // Create the indexes query
      let createIndexesQuery = 'SELECT hypopg_reset();';
      if (indexes.length > 0) {
        createIndexesQuery += SafeSqlDriver.paramSqlToQuery(
          'SELECT hypopg_create_index({});'.repeat(indexes.length),
          indexes.map((idx) => idx.definition)
        );
      }

      // Execute explain with the indexes
      const explainOptions = ['FORMAT JSON'];
      if (useGenericPlan) {
        explainOptions.push('GENERIC_PLAN');
      }
      if (indexes.length > 0) {
        explainOptions.push('COSTS TRUE');
      }

      const explainPlanQuery = `${createIndexesQuery}EXPLAIN (${explainOptions.join(', ')}) ${queryText}`;
      const planResult = await queryRows(this.sqlDriver, explainPlanQuery);

      // The tracer is mandatory on every path that reaches the trace calls
      const trace = (message: string): void => {
        if (!dta) {
          throw new TypeError('A DTA tracer is required to report an empty explain plan');
        }
        dta.dtaTrace(message);
      };

      // Extract the plan
      const planData = queryPlan(planResult);
      if (isTruthy(planData)) {
        if (Array.isArray(planData)) {
          return planData[0];
        }
        trace(`      - plan_data is an empty list with plan_data type: ${pyTypeName(planData)}`);
      }

      trace('      - returning empty plan');
      // Return empty plan if no result
      return { Plan: { 'Total Cost': Number.POSITIVE_INFINITY } };
    } catch (error) {
      logLine(`Error getting explain plan: ${errorMessage(error)}`);
      throw error;
    }
  }
}
