import { ErrorResult, ExplainPlanArtifact } from '../artifacts.ts';
import { errorMessage } from '../errors.ts';
import { isJsonObject } from '../json.ts';
import { logLine } from '../log.ts';
import { pyTypeName } from '../py-format.ts';
import { SqlBindParams } from '../sql/bind-params.ts';
import { checkPostgresVersionRequirement } from '../sql/extension-utils.ts';
import { IndexDefinition } from '../sql/index-definition.ts';
import type { SqlExecutor } from '../sql/safe-sql.ts';
import { SafeSqlDriver } from '../sql/safe-sql.ts';

const BIND_VARIABLE_PATTERN = /\$\d+/u;
const LIKE_PATTERN = /\bLIKE\b/iu;

/** The part of the index advisor the explain tool needs for trace logging. */
export interface DtaTracer {
  dtaTrace: (message: string) => void;
}

/** The `pg` json type arrives parsed; parse it when a driver hands over text. */
function parsePlanColumn(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
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

function toColumnList(columns: unknown): unknown[] {
  if (Array.isArray(columns)) {
    return columns;
  }
  if (typeof columns === 'string') {
    // oxlint-disable-next-line typescript/no-misused-spread -- mirrors upstream's list(str), see docs/TODO.md
    return [...columns];
  }
  if (isJsonObject(columns)) {
    return Object.keys(columns);
  }
  return [columns];
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
    hypotheticalIndexes: unknown
  ): Promise<ExplainPlanArtifact | ErrorResult> {
    try {
      // Validate index definitions format
      if (!Array.isArray(hypotheticalIndexes)) {
        return new ErrorResult(`Expected list of index definitions, got ${pyTypeName(hypotheticalIndexes)}`);
      }

      const indexes = new Map<string, IndexDefinition>();
      for (const idx of hypotheticalIndexes as unknown[]) {
        if (!isJsonObject(idx)) {
          return new ErrorResult(`Expected dictionary for index definition, got ${pyTypeName(idx)}`);
        }
        if (!('table' in idx)) {
          return new ErrorResult("Missing 'table' in index definition");
        }
        if (!('columns' in idx)) {
          return new ErrorResult("Missing 'columns' in index definition");
        }
        const columns = toColumnList(idx.columns).map((column) => {
          if (typeof column !== 'string') {
            throw new TypeError(`Expected string for index column, got ${pyTypeName(column)}`);
          }
          return column;
        });
        const definition = new IndexDefinition(
          String(idx.table),
          columns,
          'using' in idx ? String(idx.using) : 'btree'
        );
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
      const rows = await this.sqlDriver.executeQuery(explainQ);
      const [firstRow] = rows;
      if (!firstRow) {
        return new ErrorResult('No results returned from EXPLAIN');
      }
      if (!('QUERY PLAN' in firstRow)) {
        throw new Error("'QUERY PLAN'");
      }
      const queryPlanData = parsePlanColumn(firstRow['QUERY PLAN']);

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
      const planResult = await this.sqlDriver.executeQuery(explainPlanQuery);

      // The tracer is mandatory on every path that reaches the trace calls
      const trace = (message: string): void => {
        if (!dta) {
          throw new TypeError('A DTA tracer is required to report an empty explain plan');
        }
        dta.dtaTrace(message);
      };

      // Extract the plan
      const planData = parsePlanColumn(planResult[0]?.['QUERY PLAN']);
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
