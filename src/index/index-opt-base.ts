// biome-ignore-all lint/style/noExcessiveClassesPerFile: the recommendation types and the tuning base class belong together in index-opt-base.ts
import { readFileSync } from "node:fs";
import { calculateImprovementMultiple } from "../artifacts.ts";
import type { DtaTracer } from "../explain/explain-plan.ts";
import { ExplainPlanTool } from "../explain/explain-plan.ts";
import { SqlBindParams, TableAliasVisitor } from "../sql/bind-params.ts";
import { checkHypopgInstallationStatus } from "../sql/extension-utils.ts";
import { IndexDefinition } from "../sql/index-definition.ts";
import { AstNode, isJsonObject, parseSql } from "../sql/pg-ast.ts";
import type { SqlExecutor } from "../sql/safe-sql.ts";
import { SafeSqlDriver } from "../sql/safe-sql.ts";

export const MAX_NUM_INDEX_TUNING_QUERIES = 10;

const NATURAL_SIZE_SUFFIXES = ["kB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
const BYTES_BASE = 1000;
const MEGABYTE = 1024 * 1024;
const DEFAULT_TABLE_SIZE_BYTES = 10 * MEGABYTE;

/** An entry of the analysed workload; a pg_stat_statements row or a synthetic entry. */
export type WorkloadEntry = Record<string, unknown>;

/** A validated workload query: its (lowercased) text, parsed statement and weight. */
export type QueryWeight = readonly [
  query: string,
  stmt: AstNode,
  weight: number,
];

/** The chosen indexes and the cost of the workload with them. */
export type IndexConfiguration = [
  indexes: Set<IndexRecommendation>,
  cost: number,
];

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Python's `f"{value:.{digits}f}"`, including its spelling of non-finite values. */
export function formatFixed(value: number, digits: number): string {
  if (Number.isNaN(value)) {
    return "nan";
  }
  if (!Number.isFinite(value)) {
    return value > 0 ? "inf" : "-inf";
  }
  return value.toFixed(digits);
}

/** Python's `f"{value:.2%}"`. */
export function formatPercent(value: number): string {
  return `${formatFixed(value * 100, 2)}%`;
}

/** Python's `str(float)` for the values that occur in traces. */
export function pyFloatStr(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e16) {
    return value.toFixed(1);
  }
  return Number.isFinite(value) || Number.isNaN(value)
    ? String(value)
    : formatFixed(value, 1);
}

/** `humanize.naturalsize` (decimal units): "1 Byte", "999 Bytes", "1.0 kB", "10.5 MB". */
export function naturalSize(value: number): string {
  const absolute = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (absolute === 1) {
    return `${sign}1 Byte`;
  }
  if (absolute < BYTES_BASE) {
    return `${sign}${Math.trunc(absolute)} Bytes`;
  }
  let exponent = 1;
  let unit = BYTES_BASE;
  while (
    exponent < NATURAL_SIZE_SUFFIXES.length &&
    absolute >= unit * BYTES_BASE
  ) {
    unit *= BYTES_BASE;
    exponent += 1;
  }
  const suffix = NATURAL_SIZE_SUFFIXES[exponent - 1] ?? "";
  return `${sign}${(absolute / unit).toFixed(1)} ${suffix}`;
}

/** Pretty print a list for debugging. */
export function ppList(items: readonly unknown[]): string {
  return (
    (items.length > 0 ? "\n  - " : "") +
    items.map((item) => String(item)).join("\n  - ")
  );
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

/** Python's `int(value)` for a database cell. */
function toInt(value: unknown): number {
  if (value === null || value === undefined) {
    throw new TypeError("Expected a number");
  }
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new TypeError(`Invalid number: ${String(value)}`);
  }
  return Math.trunc(parsed);
}

function logWarning(message: string): void {
  process.stderr.write(`${message}\n`);
}

function logError(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** Represents a database index with size estimation and definition. */
export class IndexRecommendation {
  private readonly definitionValue: IndexDefinition;
  estimatedSizeBytes: number;
  potentialProblematicReason: string | null;

  constructor(
    table: string,
    columns: readonly string[],
    using = "btree",
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
    return calculateImprovementMultiple(
      this.progressiveBaseCost,
      this.progressiveRecommendationCost
    );
  }

  get potentialProblematicReason(): string | null {
    return this.indexRecommendation.potentialProblematicReason;
  }

  get estimatedSizeBytes(): number {
    return this.indexRecommendation.estimatedSizeBytes;
  }

  /** The individual improvement from this recommendation. */
  get individualImprovementMultiple(): number {
    return calculateImprovementMultiple(
      this.individualBaseCost,
      this.individualRecommendationCost
    );
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
  workloadSource = "n/a";
  workload: WorkloadEntry[] | null = null;
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
  return items.length > 0
    ? items.map((idx) => `${idx.table}(${idx.columns.join(",")})`).join(", ")
    : "(no indexes)";
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
  workload?: WorkloadEntry[];
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
  async analyzeWorkload(
    options: AnalyzeWorkloadOptions = {}
  ): Promise<IndexTuningResult> {
    const {
      workload,
      sqlFile,
      queryList,
      minCalls = 50,
      minAvgTimeMs = 5.0,
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
        session.workloadSource = "args";
        session.workload = workload;
      } else if (queryList && queryList.length > 0) {
        session.workloadSource = "query_list";
        session.workload = queryList.map((query, i) => ({
          query,
          queryid: `direct-${i}`,
        }));
      } else if (sqlFile) {
        session.workloadSource = "sql_file";
        session.workload = this.getWorkloadFromFile(sqlFile);
      } else {
        session.workloadSource = "query_store";
        session.workload = await this.getQueryStats(
          minCalls,
          minAvgTimeMs,
          limit
        );
      }

      if (session.workload.length === 0) {
        logWarning("No workload to analyze");
        return session;
      }

      session.workload = await this.validateAndParseWorkload(session.workload);

      const queryWeights = this.convertWorkloadToQueryWeights(session.workload);

      if (queryWeights.length === 0) {
        this.dtaTrace("No query provided");
        session.recommendations = [];
      } else {
        const workloadQueries = queryWeights.map(([query]) => query);

        this.dtaTrace(
          `Workload queries (${workloadQueries.length}): ${ppList(workloadQueries)}`
        );

        const recommendations =
          await this.generateRecommendations(queryWeights);
        session.recommendations = await this.formatRecommendations(
          queryWeights,
          recommendations
        );

        // Reset HypoPG only once at the end
        await this.sqlDriver.executeQuery("SELECT hypopg_reset();");
      }
    } catch (error) {
      logError(`Error in workload analysis: ${errorMessage(error)}`);
      session.error = `Error in workload analysis: ${errorMessage(error)}`;
    }

    session.dtaTraces = this.dtaTraces;
    return session;
  }

  /** Returns the session with an error when a pre-check fails, otherwise undefined. */
  async runPrechecks(
    session: IndexTuningResult
  ): Promise<IndexTuningResult | undefined> {
    // Pre-check 1: HypoPG
    const [isHypopgInstalled, hypopgMessage] =
      await checkHypopgInstallationStatus(this.sqlDriver);

    if (!isHypopgInstalled) {
      session.error = hypopgMessage;
      return session;
    }

    // Pre-check 2: ANALYZE has been run at least once
    const result = await this.sqlDriver.executeQuery(
      "SELECT s.last_analyze FROM pg_stat_user_tables s ORDER BY s.last_analyze LIMIT 1;"
    );
    if (
      !result?.some(
        (row) =>
          row.cells.last_analyze !== null &&
          row.cells.last_analyze !== undefined
      )
    ) {
      const message =
        "Statistics are not up-to-date. The database needs to be analyzed first. " +
        "Please run 'ANALYZE;' on your database before using the tuning advisor. " +
        "Without up-to-date statistics, the index recommendations may be inaccurate.";
      session.error = message;
      logError(message);
      return session;
    }

    return undefined;
  }

  /** Validate the workload to ensure it is analyzable. */
  async validateAndParseWorkload(
    workload: readonly WorkloadEntry[]
  ): Promise<WorkloadEntry[]> {
    const validated: WorkloadEntry[] = [];
    for (const entry of workload) {
      const rawQuery = entry.query;
      if (typeof rawQuery !== "string" || rawQuery === "") {
        continue;
      }
      // The whole workload SQL is lowercased
      const loweredQuery = rawQuery.trim().toLowerCase();

      // Replace parameter placeholders with dummy values
      const binding = this.sqlBindParams.replaceParameters(loweredQuery);
      // biome-ignore lint/performance/noAwaitInLoops: queries are bound one after another so statistics lookups share the cache
      const queryText = await binding;

      const { stmts } = await parseSql(queryText);
      const stmt = AstNode.from(stmts[0]?.stmt);
      if (!(stmt && this.isAnalyzableStmt(stmt))) {
        continue;
      }

      validated.push({ ...entry, query: queryText, stmt });
    }
    return validated;
  }

  convertWorkloadToQueryWeights(
    workload: readonly WorkloadEntry[]
  ): QueryWeight[] {
    const weights: QueryWeight[] = [];
    for (const entry of workload) {
      const { query, stmt } = entry;
      if (typeof query === "string" && stmt instanceof AstNode) {
        weights.push([query, stmt, this.convertQueryInfoToWeight(entry)]);
      }
    }
    return weights;
  }

  /** Convert query info to weight based on query frequency. */
  // biome-ignore lint/style/useThisInClassMethods: overridable instance method
  convertQueryInfoToWeight(queryInfo: WorkloadEntry): number {
    return (
      Number(queryInfo.calls ?? 1.0) * Number(queryInfo.avg_exec_time ?? 1.0)
    );
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
    const plan =
      await explainPlanTool.generateExplainPlanWithHypotheticalIndexes(
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
  // biome-ignore lint/style/useThisInClassMethods: overridable instance method
  getWorkloadFromFile(filePath: string): WorkloadEntry[] {
    try {
      const content = readFileSync(filePath, "utf8");
      return content
        .split(";")
        .map((text) => text.trim())
        .filter((text) => text !== "")
        .map((query, i) => ({ queryid: i, query }));
    } catch (error) {
      throw new Error(`Error loading queries from file ${filePath}`, {
        cause: error,
      });
    }
  }

  /** Get query statistics from pg_stat_statements. */
  getQueryStats(
    minCalls: number,
    minAvgTimeMs: number,
    limit: number
  ): Promise<WorkloadEntry[]> {
    return this.getQueryStatsDirect(minCalls, minAvgTimeMs, limit);
  }

  async getQueryStatsDirect(
    minCalls = 50,
    minAvgTimeMs = 5.0,
    limit = 100
  ): Promise<WorkloadEntry[]> {
    const query = `
        SELECT queryid, query, calls, total_exec_time/calls as avg_exec_time
        FROM pg_stat_statements
        WHERE calls >= {}
        AND total_exec_time/calls >= {}
        ORDER BY total_exec_time DESC
        LIMIT {}
        `;
    const result = await SafeSqlDriver.executeParamQuery(
      this.sqlDriver,
      query,
      [minCalls, minAvgTimeMs, limit]
    );
    return result ? result.map((row) => ({ ...row.cells })) : [];
  }

  /** Check if a statement can be analyzed for index recommendations. */
  // biome-ignore lint/style/useThisInClassMethods: overridable instance method
  isAnalyzableStmt(stmt: AstNode): boolean {
    if (!stmt.is("SelectStmt")) {
      return false;
    }

    const visitor = new TableAliasVisitor();
    visitor.visit(stmt);

    // Skip queries that only access system tables
    return ![...visitor.tables].every(
      (table) => table.startsWith("pg_") || table.startsWith("aurora_")
    );
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
      this.dtaTrace(
        `  - Using cached cost for configuration: ${candidateStr(unique)}`
      );
      return cached;
    }

    this.dtaTrace(
      `  - Evaluating cost for configuration: ${candidateStr(unique)}`
    );

    let totalCost = 0.0;
    let validQueries = 0;

    try {
      for (const [queryText, , weight] of weightedWorkload) {
        try {
          // biome-ignore lint/performance/noAwaitInLoops: explain plans are requested one query at a time against a single connection
          const planData = await this.getExplainPlanWithIndexes(
            queryText,
            unique
          );
          const cost = IndexTuningBase.extractCostFromJsonPlan(planData);
          totalCost += cost * weight;
          validQueries += 1;
        } catch (error) {
          throw new Error(`Error executing explain for query: ${queryText}`, {
            cause: error,
          });
        }
      }

      if (validQueries === 0) {
        this.dtaTrace("    + no valid queries found for cost evaluation");
        return Number.POSITIVE_INFINITY;
      }

      const avgCost = totalCost / validQueries;
      this.costCache.set(cacheKey, avgCost);
      this.dtaTrace(
        `    + config cost: ${formatFixed(avgCost, 2)} (from ${validQueries} queries)`
      );
      return avgCost;
    } catch (error) {
      this.dtaTrace(
        `    + error evaluating configuration: ${errorMessage(error)}`
      );
      throw new Error("Error evaluating configuration", { cause: error });
    }
  }

  async estimateIndexSize(
    table: string,
    columns: readonly string[]
  ): Promise<number> {
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
      const result = await SafeSqlDriver.executeParamQuery(
        this.sqlDriver,
        statsQuery,
        [table, columns]
      );
      const first = result?.[0];
      if (first && Object.keys(first.cells).length > 0) {
        const sizeEstimate = this.estimateIndexSizeInternal(first.cells);
        this.sizeEstimateCache.set(cacheKey, sizeEstimate);
        return sizeEstimate;
      }
      return 0;
    } catch (error) {
      throw new Error("Error estimating index size", { cause: error });
    }
  }

  // biome-ignore lint/style/useThisInClassMethods: overridable instance method
  estimateIndexSizeInternal(stats: Readonly<Record<string, unknown>>): number {
    // 8 bytes for the heap TID
    const width = (Number(stats.total_width ?? 0) || 0) + 8;
    let ndistinct = Number(stats.total_distinct ?? 0) || 1.0;
    ndistinct = ndistinct > 0 ? ndistinct : 1.0;
    // simplistic formula
    return Math.trunc(width * ndistinct * 2.0);
  }

  /** Format the best configuration into recommendations with cost estimates. */
  async formatRecommendations(
    queryWeights: readonly QueryWeight[],
    bestConfig: IndexConfiguration
  ): Promise<IndexRecommendationAnalysis[]> {
    const recommendations: IndexRecommendationAnalysis[] = [];
    let totalSize = 0;
    const budgetBytes = this.budgetMb * MEGABYTE;
    const individualBaseCost =
      (await this.evaluateConfigurationCost(queryWeights, [])) || 1.0;
    let progressiveBaseCost = individualBaseCost;
    const indexesSoFar: IndexRecommendation[] = [];
    for (const indexConfig of bestConfig[0]) {
      indexesSoFar.push(indexConfig);
      // biome-ignore lint/performance/noAwaitInLoops: each recommendation builds on the previous ones and shares the cost cache
      const progressiveCost = await this.evaluateConfigurationCost(
        queryWeights,
        indexesSoFar.map((idx) => idx.indexDefinition)
      );
      const individualCost = await this.evaluateConfigurationCost(
        queryWeights,
        [indexConfig.indexDefinition]
      );

      const size = await this.estimateIndexSize(
        indexConfig.table,
        indexConfig.columns
      );
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
        this.dtaTrace(
          `Skipping index: ${candidateStr([indexConfig])} because it exceeds budget`
        );
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
      logError(`No top plan found in plan data: ${JSON.stringify(planData)}`);
      return Number.POSITIVE_INFINITY;
    }

    const totalCost = topPlan["Total Cost"];
    if (totalCost === null || totalCost === undefined) {
      logError(`Total Cost not found in top plan: ${JSON.stringify(topPlan)}`);
      return Number.POSITIVE_INFINITY;
    }

    const cost = Number(totalCost);
    if (Number.isNaN(cost)) {
      throw new Error("Error extracting cost from plan");
    }
    return cost;
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
      const query =
        "SELECT pg_total_relation_size(quote_ident({})) as rel_size";
      const result = await SafeSqlDriver.executeParamQuery(
        this.sqlDriver,
        query,
        [table]
      );

      const first = result?.[0];
      if (first && Object.keys(first.cells).length > 0) {
        size = toInt(first.cells.rel_size);
      } else {
        // If the query fails, use our estimation method
        size = await this.estimateTableSize(table);
      }
    } catch (error) {
      logWarning(
        `Error getting table size for ${table}: ${errorMessage(error)}`
      );
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
      const result = await SafeSqlDriver.executeParamQuery(
        this.sqlDriver,
        "SELECT count(*) as row_count FROM {}",
        [table]
      );
      const first = result?.[0];
      if (first && Object.keys(first.cells).length > 0) {
        const rowCount = toInt(first.cells.row_count);
        // Rough estimate: assume 1KB per row
        return rowCount * 1024;
      }
    } catch (error) {
      logWarning(
        `Error estimating table size for ${table}: ${errorMessage(error)}`
      );
    }

    return DEFAULT_TABLE_SIZE_BYTES;
  }

  /** Generate index recommendations and the workload cost with them. */
  protected abstract generateRecommendations(
    queryWeights: readonly QueryWeight[]
  ): Promise<IndexConfiguration>;
}
