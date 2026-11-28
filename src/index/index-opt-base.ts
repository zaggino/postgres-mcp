import { readFileSync } from 'node:fs';

import { calculateImprovementMultiple } from '../artifacts.ts';
import { errorMessage } from '../errors.ts';
import type { DtaTracer } from '../explain/explain-plan.ts';
import { ExplainPlanTool } from '../explain/explain-plan.ts';
import { isJsonObject } from '../json.ts';
import { logLine } from '../log.ts';
import { formatFixed } from '../py-format.ts';
import { SqlBindParams, TableAliasVisitor } from '../sql/bind-params.ts';
import * as cell from '../sql/cells.ts';
import { checkHypopgInstallationStatus } from '../sql/extension-utils.ts';
import { IndexDefinition } from '../sql/index-definition.ts';
import { AstNode, parseSql } from '../sql/pg-ast.ts';
import type { SqlExecutor } from '../sql/safe-sql.ts';
import { SafeSqlDriver, queryRows } from '../sql/safe-sql.ts';
import type { Row } from '../sql/sql-driver.ts';

export const MAX_NUM_INDEX_TUNING_QUERIES = 10;

const MEGABYTE = 1024 * 1024;
const DEFAULT_TABLE_SIZE_BYTES = 10 * MEGABYTE;

/** A query of the analysed workload, with its pg_stat_statements statistics when it came from there. */
export interface WorkloadQuery {
  query: string;
  stats?: { calls: number; avgExecTimeMs: number };
}

/** A workload query that parsed to an analysable statement. */
interface ParsedWorkloadQuery extends WorkloadQuery {
  stmt: AstNode;
}

/** The row's workload query, or null when its text is hidden or gone. */
function toWorkloadQuery(row: Row): WorkloadQuery | null {
  // NULL when the role cannot see another role's text or the query-text file was garbage-collected
  const query = cell.nullableText(row, 'query');
  if (query === null) {
    return null;
  }
  return {
    query,
    // calls is only a weight, so rounding a bigint beyond 2^53 does not matter
    stats: { calls: Number(cell.int8(row, 'calls')), avgExecTimeMs: cell.numeric(row, 'avg_exec_time') },
  };
}

/** A validated workload query: its (lowercased) text, parsed statement and weight. */
export type QueryWeight = readonly [query: string, stmt: AstNode, weight: number];

/** The chosen indexes and the cost of the workload with them. */
export type IndexConfiguration = [indexes: Set<IndexRecommendation>, cost: number];

/** Pretty print a list for debugging. */
export function ppList(items: readonly unknown[]): string {
  return (items.length > 0 ? '\n  - ' : '') + items.map((item) => String(item)).join('\n  - ');
}

/** Stable identity of a set of indexes, independent of order and duplicates. */
export function configurationKey(indexes: readonly IndexDefinition[]): string {
  return JSON.stringify([...new Set(indexes.map((idx) => idx.key))].sort());
}

function uniqueIndexes(indexes: readonly IndexDefinition[]): IndexDefinition[] {
  return [...new Map(indexes.map((idx) => [idx.key, idx])).values()];
}

function isEmptyPlan(plan: unknown): boolean {
  if (isJsonObject(plan)) {
    return Object.keys(plan).length === 0;
  }
  return !plan;
}

/** Represents a database index with size estimation and definition. */
export class IndexRecommendation {
  private readonly definitionValue: IndexDefinition;
  estimatedSizeBytes: number;
  potentialProblematicReason: string | null;

  constructor(
    table: string,
    columns: readonly string[],
    using = 'btree',
    estimatedSizeBytes = 0,
    potentialProblematicReason: string | null = null
  ) {
    this.definitionValue = new IndexDefinition(table, columns, using);
    this.estimatedSizeBytes = estimatedSizeBytes;
    this.potentialProblematicReason = potentialProblematicReason;
  }

  get indexDefinition(): IndexDefinition {
    return this.definitionValue;
  }

  get definition(): string {
    return this.definitionValue.definition;
  }

  get name(): string {
    return this.definitionValue.name;
  }

  get columns(): readonly string[] {
    return this.definitionValue.columns;
  }

  get table(): string {
    return this.definitionValue.table;
  }

  get using(): string {
    return this.definitionValue.using;
  }

  toString(): string {
    return `${this.definitionValue.toString()} (estimated_size_bytes: ${this.estimatedSizeBytes})`;
  }
}

export interface IndexRecommendationAnalysisInit {
  definition: string;
  indexRecommendation: IndexRecommendation;
  individualBaseCost: number;
  individualRecommendationCost: number;
  progressiveBaseCost: number;
  progressiveRecommendationCost: number;
  queries: string[];
}

/** Represents a recommended index with benefit estimation. */
export class IndexRecommendationAnalysis {
  readonly indexRecommendation: IndexRecommendation;
  readonly progressiveBaseCost: number;
  readonly progressiveRecommendationCost: number;
  readonly individualBaseCost: number;
  readonly individualRecommendationCost: number;
  readonly queries: string[];
  readonly definition: string;

  constructor(init: IndexRecommendationAnalysisInit) {
    this.indexRecommendation = init.indexRecommendation;
    this.progressiveBaseCost = init.progressiveBaseCost;
    this.progressiveRecommendationCost = init.progressiveRecommendationCost;
    this.individualBaseCost = init.individualBaseCost;
    this.individualRecommendationCost = init.individualRecommendationCost;
    this.queries = init.queries;
    this.definition = init.definition;
  }

  get table(): string {
    return this.indexRecommendation.table;
  }

  get columns(): readonly string[] {
    return this.indexRecommendation.columns;
  }

  get using(): string {
    return this.indexRecommendation.using;
  }

  /** The progressive improvement from this recommendation. */
  get progressiveImprovementMultiple(): number {
    return calculateImprovementMultiple(this.progressiveBaseCost, this.progressiveRecommendationCost);
  }

  get potentialProblematicReason(): string | null {
    return this.indexRecommendation.potentialProblematicReason;
  }

  get estimatedSizeBytes(): number {
    return this.indexRecommendation.estimatedSizeBytes;
  }

  /** The individual improvement from this recommendation. */
  get individualImprovementMultiple(): number {
    return calculateImprovementMultiple(this.individualBaseCost, this.individualRecommendationCost);
  }

  toIndex(): IndexRecommendation {
    return this.indexRecommendation;
  }
}

/** Results of index tuning analysis. */
export class IndexTuningResult {
  /** Session ID for tracing. */
  sessionId: string;
  /** Tuning budget in MB. */
  budgetMb: number;
  /** 'args', 'query_list', 'query_store', 'sql_file' */
  workloadSource = 'n/a';
  workload: WorkloadQuery[] | null = null;
  recommendations: IndexRecommendationAnalysis[] = [];
  error: string | null = null;
  dtaTraces: string[] = [];

  constructor(sessionId: string, budgetMb: number) {
    this.sessionId = sessionId;
    this.budgetMb = budgetMb;
  }
}

interface IndexLike {
  columns: readonly string[];
  table: string;
}

export function candidateStr(indexes: Iterable<IndexLike>): string {
  const items = [...indexes];
  return items.length > 0 ? items.map((idx) => `${idx.table}(${idx.columns.join(',')})`).join(', ') : '(no indexes)';
}

export interface AnalyzeWorkloadOptions {
  /** Maximum number of queries to analyze (for pg_stat_statements). */
  limit?: number;
  /** Maximum total size of recommended indexes in MB. */
  maxIndexSizeMb?: number;
  /** Minimum average execution time in ms (for pg_stat_statements). */
  minAvgTimeMs?: number;
  /** Minimum number of calls for a query to be considered (for pg_stat_statements). */
  minCalls?: number;
  /** SQL query strings to analyze. */
  queryList?: string[];
  /** Path to a file containing SQL queries. */
  sqlFile?: string;
  /** Explicit workload data. */
  workload?: WorkloadQuery[];
}

export abstract class IndexTuningBase implements DtaTracer {
  readonly sqlDriver: SqlExecutor;

  costCache = new Map<string, number>();
  sizeEstimateCache = new Map<string, number>();
  tableSizeCache = new Map<string, number>();
  explainPlansCache = new Map<string, Record<string, unknown>>();
  readonly sqlBindParams: SqlBindParams;

  /** Storage budget in MB; a value <= 0 means no limit. */
  budgetMb = -1;
  /** `performance.now()` at the start of the current analysis. */
  analysisStartTime = 0;

  dtaTraces: string[] = [];

  constructor(sqlDriver: SqlExecutor) {
    this.sqlDriver = sqlDriver;
    this.sqlBindParams = new SqlBindParams(this.sqlDriver);
  }

  /**
   * Analyze query workload and recommend indexes. The workload comes from, in
   * priority order: the explicit workload, the query list, the SQL file, or
   * the pg_stat_statements query statistics.
   */
  async analyzeWorkload(options: AnalyzeWorkloadOptions = {}): Promise<IndexTuningResult> {
    const {
      workload,
      sqlFile,
      queryList,
      minCalls = 50,
      minAvgTimeMs = 5,
      limit = MAX_NUM_INDEX_TUNING_QUERIES,
      maxIndexSizeMb = -1,
    } = options;
    const sessionId = String(Math.floor(Date.now() / 1000));
    this.analysisStartTime = performance.now();
    this.dtaTraces = [];

    // Clear the cache at the beginning of each analysis
    this.sizeEstimateCache = new Map();

    if (maxIndexSizeMb > 0) {
      this.budgetMb = maxIndexSizeMb;
    }

    const session = new IndexTuningResult(sessionId, maxIndexSizeMb);

    try {
      const precheckResult = await this.runPrechecks(session);
      if (precheckResult) {
        return precheckResult;
      }

      if (workload && workload.length > 0) {
        session.workloadSource = 'args';
        session.workload = workload;
      } else if (queryList && queryList.length > 0) {
        session.workloadSource = 'query_list';
        session.workload = queryList.map((query) => ({ query }));
      } else if (sqlFile) {
        session.workloadSource = 'sql_file';
        session.workload = this.getWorkloadFromFile(sqlFile);
      } else {
        session.workloadSource = 'query_store';
        session.workload = await this.getQueryStats(minCalls, minAvgTimeMs, limit);
      }

      if (session.workload.length === 0) {
        logLine('No workload to analyze');
        return session;
      }

      const parsedWorkload = await this.validateAndParseWorkload(session.workload);

      const queryWeights = this.convertWorkloadToQueryWeights(parsedWorkload);

      if (queryWeights.length === 0) {
        this.dtaTrace('No query provided');
        session.recommendations = [];
      } else {
        const workloadQueries = queryWeights.map(([query]) => query);

        this.dtaTrace(`Workload queries (${workloadQueries.length}): ${ppList(workloadQueries)}`);

        const recommendations = await this.generateRecommendations(queryWeights);
        session.recommendations = await this.formatRecommendations(queryWeights, recommendations);

        // Reset HypoPG only once at the end
        await queryRows(this.sqlDriver, 'SELECT hypopg_reset();');
      }
    } catch (error) {
      logLine(`Error in workload analysis: ${errorMessage(error)}`);
      session.error = `Error in workload analysis: ${errorMessage(error)}`;
    }

    session.dtaTraces = this.dtaTraces;
    return session;
  }

  /** Returns the session with an error when a pre-check fails, otherwise undefined. */
  async runPrechecks(session: IndexTuningResult): Promise<IndexTuningResult | undefined> {
    // Pre-check 1: HypoPG
    const [isHypopgInstalled, hypopgMessage] = await checkHypopgInstallationStatus(this.sqlDriver);

    if (!isHypopgInstalled) {
      session.error = hypopgMessage;
      return session;
    }

    // Pre-check 2: ANALYZE has been run at least once
    const result = await queryRows(
      this.sqlDriver,
      'SELECT s.last_analyze FROM pg_stat_user_tables s ORDER BY s.last_analyze LIMIT 1;'
    );
    if (!result.some((row) => cell.value(row, 'last_analyze') !== null)) {
      const message =
        'Statistics are not up-to-date. The database needs to be analyzed first. ' +
        "Please run 'ANALYZE;' on your database before using the tuning advisor. " +
        'Without up-to-date statistics, the index recommendations may be inaccurate.';
      session.error = message;
      logLine(message);
      return session;
    }

    return undefined;
  }

  /** Validate the workload to ensure it is analyzable. */
  async validateAndParseWorkload(workload: readonly WorkloadQuery[]): Promise<ParsedWorkloadQuery[]> {
    const validated: ParsedWorkloadQuery[] = [];
    for (const entry of workload) {
      if (entry.query === '') {
        continue;
      }
      // The whole workload SQL is lowercased
      const loweredQuery = entry.query.trim().toLowerCase();

      // Replace parameter placeholders with dummy values
      const queryText = await this.sqlBindParams.replaceParameters(loweredQuery);

      const { stmts } = await parseSql(queryText);
      const stmt = AstNode.from(stmts[0]?.stmt);
      if (!(stmt && this.isAnalyzableStmt(stmt))) {
        continue;
      }

      validated.push({ ...entry, query: queryText, stmt });
    }
    return validated;
  }

  convertWorkloadToQueryWeights(workload: readonly ParsedWorkloadQuery[]): QueryWeight[] {
    return workload.map((entry) => [entry.query, entry.stmt, this.convertQueryInfoToWeight(entry)]);
  }

  /** Convert query info to weight based on query frequency. */
  convertQueryInfoToWeight(entry: WorkloadQuery): number {
    // An entry without statistics weighs 1
    return entry.stats ? entry.stats.calls * entry.stats.avgExecTimeMs : 1;
  }

  /**
   * Get the explain plan for a query with a specific set of indexes.
   * Results are memoized to avoid redundant explain operations.
   */
  async getExplainPlanWithIndexes(
    queryText: string,
    indexes: readonly IndexDefinition[]
  ): Promise<Record<string, unknown>> {
    const cacheKey = JSON.stringify([queryText, configurationKey(indexes)]);

    const existingPlan = this.explainPlansCache.get(cacheKey);
    if (existingPlan && !isEmptyPlan(existingPlan)) {
      return existingPlan;
    }

    const explainPlanTool = new ExplainPlanTool(this.sqlDriver);
    const plan = await explainPlanTool.generateExplainPlanWithHypotheticalIndexes(
      queryText,
      uniqueIndexes(indexes),
      false,
      this
    );

    const result = isJsonObject(plan) ? { ...plan } : {};
    this.explainPlansCache.set(cacheKey, result);
    return result;
  }

  /** Load queries from an SQL file, split on semicolons. */
  getWorkloadFromFile(filePath: string): WorkloadQuery[] {
    try {
      const content = readFileSync(filePath, 'utf-8');
      return content
        .split(';')
        .map((text) => text.trim())
        .filter((text) => text !== '')
        .map((query) => ({ query }));
    } catch (error) {
      throw new Error(`Error loading queries from file ${filePath}`, {
        cause: error,
      });
    }
  }

  /** Get query statistics from pg_stat_statements. */
  getQueryStats(minCalls: number, minAvgTimeMs: number, limit: number): Promise<WorkloadQuery[]> {
    return this.getQueryStatsDirect(minCalls, minAvgTimeMs, limit);
  }

  async getQueryStatsDirect(minCalls = 50, minAvgTimeMs = 5, limit = 100): Promise<WorkloadQuery[]> {
    const query = `
        SELECT query, calls, total_exec_time/calls as avg_exec_time
        FROM pg_stat_statements
        WHERE calls >= {}
        AND total_exec_time/calls >= {}
        ORDER BY total_exec_time DESC
        LIMIT {}
        `;
    const result = await SafeSqlDriver.executeParamQuery(this.sqlDriver, query, [minCalls, minAvgTimeMs, limit]);
    return result.flatMap((row) => toWorkloadQuery(row) ?? []);
  }

  /** Check if a statement can be analyzed for index recommendations. */
  isAnalyzableStmt(stmt: AstNode): boolean {
    if (!stmt.is('SelectStmt')) {
      return false;
    }

    const visitor = new TableAliasVisitor();
    visitor.visit(stmt);

    // Skip queries that only access system tables
    return ![...visitor.tables].every((table) => table.startsWith('pg_') || table.startsWith('aurora_'));
  }

  /** Record a step of the DTA thinking process. */
  dtaTrace(message: string): void {
    this.dtaTraces.push(message);
  }

  /** Evaluate total cost with selective enabling and caching. */
  async evaluateConfigurationCost(
    weightedWorkload: readonly QueryWeight[],
    indexes: readonly IndexDefinition[]
  ): Promise<number> {
    const unique = uniqueIndexes(indexes);
    const cacheKey = configurationKey(unique);
    const cached = this.costCache.get(cacheKey);
    if (cached !== undefined) {
      this.dtaTrace(`  - Using cached cost for configuration: ${candidateStr(unique)}`);
      return cached;
    }

    this.dtaTrace(`  - Evaluating cost for configuration: ${candidateStr(unique)}`);

    let totalCost = 0;
    let validQueries = 0;

    try {
      for (const [queryText, , weight] of weightedWorkload) {
        try {
          const planData = await this.getExplainPlanWithIndexes(queryText, unique);
          const cost = IndexTuningBase.extractCostFromJsonPlan(planData);
          totalCost += cost * weight;
          validQueries += 1;
        } catch (error) {
          throw new Error('Error executing explain for a workload query', {
            cause: error,
          });
        }
      }

      if (validQueries === 0) {
        this.dtaTrace('    + no valid queries found for cost evaluation');
        return Number.POSITIVE_INFINITY;
      }

      const avgCost = totalCost / validQueries;
      this.costCache.set(cacheKey, avgCost);
      this.dtaTrace(`    + config cost: ${formatFixed(avgCost, 2)} (from ${validQueries} queries)`);
      return avgCost;
    } catch (error) {
      this.dtaTrace(`    + error evaluating configuration: ${errorMessage(error)}`);
      throw new Error('Error evaluating configuration', { cause: error });
    }
  }

  async estimateIndexSize(table: string, columns: readonly string[]): Promise<number> {
    const cacheKey = JSON.stringify([table, [...new Set(columns)].sort()]);

    const cached = this.sizeEstimateCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    try {
      const statsQuery = `
            SELECT COALESCE(SUM(avg_width), 0) AS total_width,
                   COALESCE(SUM(n_distinct), 0) AS total_distinct
            FROM pg_stats
            WHERE tablename = {} AND attname = ANY({})
            `;
      const result = await SafeSqlDriver.executeParamQuery(this.sqlDriver, statsQuery, [table, columns]);
      // An aggregate without GROUP BY always returns one row
      const first = cell.single(result);
      const sizeEstimate = this.estimateIndexSizeInternal({
        totalWidth: cell.integer(first, 'total_width'),
        totalDistinct: cell.numeric(first, 'total_distinct'),
      });
      this.sizeEstimateCache.set(cacheKey, sizeEstimate);
      return sizeEstimate;
    } catch (error) {
      throw new Error('Error estimating index size', { cause: error });
    }
  }

  estimateIndexSizeInternal(stats: { totalWidth: number; totalDistinct: number }): number {
    // 8 bytes for the heap TID
    const width = stats.totalWidth + 8;
    const ndistinct = stats.totalDistinct > 0 ? stats.totalDistinct : 1;
    // simplistic formula
    return Math.trunc(width * ndistinct * 2);
  }

  /** Format the best configuration into recommendations with cost estimates. */
  async formatRecommendations(
    queryWeights: readonly QueryWeight[],
    bestConfig: IndexConfiguration
  ): Promise<IndexRecommendationAnalysis[]> {
    const recommendations: IndexRecommendationAnalysis[] = [];
    let totalSize = 0;
    const budgetBytes = this.budgetMb * MEGABYTE;
    const individualBaseCost = (await this.evaluateConfigurationCost(queryWeights, [])) || 1;
    let progressiveBaseCost = individualBaseCost;
    const indexesSoFar: IndexRecommendation[] = [];
    for (const indexConfig of bestConfig[0]) {
      indexesSoFar.push(indexConfig);
      const progressiveCost = await this.evaluateConfigurationCost(
        queryWeights,
        indexesSoFar.map((idx) => idx.indexDefinition)
      );
      const individualCost = await this.evaluateConfigurationCost(queryWeights, [indexConfig.indexDefinition]);

      const size = await this.estimateIndexSize(indexConfig.table, indexConfig.columns);
      if (budgetBytes < 0 || totalSize + size <= budgetBytes) {
        this.dtaTrace(`Adding index: ${candidateStr([indexConfig])}`);
        recommendations.push(
          new IndexRecommendationAnalysis({
            indexRecommendation: new IndexRecommendation(
              indexConfig.table,
              indexConfig.columns,
              indexConfig.using,
              size,
              indexConfig.potentialProblematicReason
            ),
            progressiveBaseCost,
            progressiveRecommendationCost: progressiveCost,
            individualBaseCost,
            individualRecommendationCost: individualCost,
            queries: queryWeights.map(([query]) => query),
            definition: indexConfig.definition,
          })
        );
        progressiveBaseCost = progressiveCost;
        totalSize += size;
      } else {
        this.dtaTrace(`Skipping index: ${candidateStr([indexConfig])} because it exceeds budget`);
      }
    }

    return recommendations;
  }

  /** Extract total cost from JSON EXPLAIN plan data. */
  static extractCostFromJsonPlan(planData: unknown): number {
    if (isEmptyPlan(planData) || !isJsonObject(planData)) {
      return Number.POSITIVE_INFINITY;
    }

    const topPlan = planData.Plan;
    if (!isJsonObject(topPlan) || Object.keys(topPlan).length === 0) {
      logLine('No top plan found in plan data');
      return Number.POSITIVE_INFINITY;
    }

    const totalCost = topPlan['Total Cost'];
    if (totalCost === null || totalCost === undefined) {
      logLine('Total Cost not found in top plan');
      return Number.POSITIVE_INFINITY;
    }

    if (typeof totalCost !== 'number' || Number.isNaN(totalCost)) {
      throw new Error('Error extracting cost from plan');
    }
    return totalCost;
  }

  /**
   * The total size of a table including indexes and toast tables, memoized to
   * avoid repeated database queries.
   */
  async getTableSize(table: string): Promise<number> {
    const cached = this.tableSizeCache.get(table);
    if (cached !== undefined) {
      return cached;
    }

    let size: number;
    try {
      const query = 'SELECT pg_total_relation_size(quote_ident({})) as rel_size';
      const result = await SafeSqlDriver.executeParamQuery(this.sqlDriver, query, [table]);

      size = cell.integer(cell.single(result), 'rel_size');
    } catch (error) {
      logLine(`Error getting table size for ${table}: ${errorMessage(error)}`);
      size = await this.estimateTableSize(table);
    }
    this.tableSizeCache.set(table, size);
    return size;
  }

  /** Estimate the size of a table if we can't get it from the database. */
  async estimateTableSize(table: string): Promise<number> {
    try {
      // The table name becomes a string literal here, which is not valid SQL
      // after FROM; the resulting error leads to the default size.
      const result = await SafeSqlDriver.executeParamQuery(this.sqlDriver, 'SELECT count(*) as row_count FROM {}', [
        table,
      ]);
      const rowCount = cell.integer(cell.single(result), 'row_count');
      // Rough estimate: assume 1KB per row
      return rowCount * 1024;
    } catch (error) {
      logLine(`Error estimating table size for ${table}: ${errorMessage(error)}`);
    }

    return DEFAULT_TABLE_SIZE_BYTES;
  }

  /** Generate index recommendations and the workload cost with them. */
  protected abstract generateRecommendations(queryWeights: readonly QueryWeight[]): Promise<IndexConfiguration>;
}
