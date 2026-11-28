import { isJsonObject } from '../json.ts';
import { formatFixed, formatPercent, naturalSize, pyFloatStr } from '../py-format.ts';
import { ColumnCollector, TableAliasVisitor } from '../sql/bind-params.ts';
import * as cell from '../sql/cells.ts';
import { literal } from '../sql/literal.ts';
import { AstNode, loadParser, parseSqlSync } from '../sql/pg-ast.ts';
import type { SqlExecutor } from '../sql/safe-sql.ts';
import { SafeSqlDriver, queryRows } from '../sql/safe-sql.ts';
import type { Row } from '../sql/sql-driver.ts';
import type { IndexConfiguration, QueryWeight } from './index-opt-base.ts';
import { candidateStr, IndexRecommendation, IndexTuningBase } from './index-opt-base.ts';

const MEGABYTE = 1024 * 1024;

export interface DatabaseTuningAdvisorOptions {
  /** Storage budget in MB; no limit by default. */
  budgetMb?: number;
  /** Maximum columns in an index. */
  maxIndexWidth?: number;
  /** Time limit for the entire analysis (anytime approach). */
  maxRuntimeSeconds?: number;
  /** Skip columns that appear in fewer than this many queries. */
  minColumnUsage?: number;
  /** Stop when the relative time improvement falls below this threshold. */
  minTimeImprovement?: number;
  /** Weight of the space term of the objective function. */
  paretoAlpha?: number;
  /** How many top single-column indexes to pick as seeds. */
  seedColumnsCount?: number;
}

export interface IndexInfo {
  columns: string[];
  table: string;
  type: string;
  unique: boolean;
}

/** Python's `math.log`, which rejects non-positive values. */
function pyLog(value: number): number {
  if (value <= 0) {
    throw new RangeError('math domain error');
  }
  return Math.log(value);
}

/** Python's `/`, which rejects a zero divisor. */
function pyDivide(dividend: number, divisor: number): number {
  if (divisor === 0) {
    throw new RangeError('float division by zero');
  }
  return dividend / divisor;
}

/** Python's `itertools.combinations`. */
function* combinations<T>(items: readonly T[], size: number): Generator<T[]> {
  if (size > items.length) {
    return;
  }
  if (size === 0) {
    yield [];
    return;
  }
  for (let i = 0; i <= items.length - size; i += 1) {
    const head = items[i];
    if (head === undefined) {
      continue;
    }
    for (const tail of combinations(items.slice(i + 1), size - 1)) {
      yield [head, ...tail];
    }
  }
}

/** A column of a candidate table; avgWidth is null when pg_stats has no statistics for it. */
interface LongTextRow {
  tableName: string;
  columnName: string;
  avgWidth: number | null;
  potentialLongText: boolean;
}

function toLongTextRow(row: Row): LongTextRow {
  return {
    tableName: cell.text(row, 'table_name'),
    columnName: cell.text(row, 'column_name'),
    avgWidth: cell.nullableInteger(row, 'avg_width'),
    potentialLongText: cell.boolean(row, 'potential_long_text'),
  };
}

/** An index of the database, as pg_indexes describes it. */
export interface ExistingIndex {
  schema: string;
  table: string;
  name: string;
  definition: string;
}

function toExistingIndex(row: Row): ExistingIndex {
  return {
    schema: cell.text(row, 'schema'),
    table: cell.text(row, 'table'),
    name: cell.text(row, 'name'),
    definition: cell.text(row, 'definition'),
  };
}

/**
 * Classifies a catalog row of a column. avg_width from pg_stats is a
 * heuristic: a high value means the column likely contains long text.
 */
function classifyLongText(row: LongTextRow, maxTextLength: number): 'problematic' | 'potential' | undefined {
  if (!row.potentialLongText) {
    return undefined;
  }
  return row.avgWidth === null || row.avgWidth > maxTextLength * 0.4 ? 'problematic' : 'potential';
}

function pairKey(table: string, column: string): string {
  return JSON.stringify([table, column]);
}

/** The `sval`s of the String nodes of a list field. */
function stringList(node: AstNode, field: string): string[] {
  return node
    .nodes(field)
    .filter((item) => item.is('String'))
    .map((item) => item.string('sval') ?? '');
}

export class DatabaseTuningAdvisor extends IndexTuningBase {
  maxRuntimeSeconds: number;
  maxIndexWidth: number;
  minColumnUsage: number;
  seedColumnsCount: number;
  paretoAlpha: number;
  minTimeImprovement: number;

  constructor(sqlDriver: SqlExecutor, options: DatabaseTuningAdvisorOptions = {}) {
    super(sqlDriver);
    this.budgetMb = options.budgetMb ?? -1;
    this.maxRuntimeSeconds = options.maxRuntimeSeconds ?? 30;
    this.maxIndexWidth = options.maxIndexWidth ?? 3;
    this.minColumnUsage = options.minColumnUsage ?? 1;
    this.seedColumnsCount = options.seedColumnsCount ?? 3;
    this.analysisStartTime = 0;
    this.paretoAlpha = options.paretoAlpha ?? 2;
    this.minTimeImprovement = options.minTimeImprovement ?? 0.1;
  }

  /** Return true if we have exceeded maxRuntimeSeconds. */
  checkTime(): boolean {
    if (this.maxRuntimeSeconds <= 0) {
      return false;
    }
    const elapsedSeconds = (performance.now() - this.analysisStartTime) / 1000;
    return elapsedSeconds > this.maxRuntimeSeconds;
  }

  /** Generate index recommendations using a 'seed + greedy' approach with a time cutoff. */
  protected override async generateRecommendations(queryWeights: readonly QueryWeight[]): Promise<IndexConfiguration> {
    const existingIndexDefs = new Set((await this.getExistingIndexes()).map((idx) => idx.definition));

    const allCandidates = await this.generateCandidates(queryWeights, existingIndexDefs);

    this.dtaTrace(`All candidates (${allCandidates.length}): ${candidateStr(allCandidates)}`);

    // Only the empty seed is used: the greedy search starts from no indexes.
    const seedsList: Set<IndexRecommendation>[] = [new Set()];

    let bestConfig: IndexConfiguration = [new Set(), Number.POSITIVE_INFINITY];

    for (const seed of seedsList) {
      if (this.checkTime()) {
        break;
      }

      this.dtaTrace('Evaluating seed:');
      const currentCost = await this.evaluateConfigurationCost(
        queryWeights,
        [...seed].map((idx) => idx.indexDefinition)
      );
      const candidateIndexes = new Set(allCandidates.map((c) => new IndexRecommendation(c.table, c.columns, c.using)));
      for (const idx of seed) {
        candidateIndexes.delete(idx);
      }
      const [finalIndexes, finalCost] = await this.enumerateGreedy(
        queryWeights,
        new Set(seed),
        currentCost,
        candidateIndexes
      );

      if (finalCost < bestConfig[1]) {
        bestConfig = [finalIndexes, finalCost];
      }
    }

    return bestConfig;
  }

  /** Generates index candidates from queries, with batch creation. */
  async generateCandidates(
    workload: readonly QueryWeight[],
    existingDefs: ReadonlySet<string>
  ): Promise<IndexRecommendation[]> {
    // The parser must be loaded before the synchronous index comparison.
    await loadParser();

    const tableColumnsUsage = this.countColumnUsage(workload);

    // Filter out columns that appear in fewer than minColumnUsage queries
    const tableColumns = new Map<string, string[]>();
    for (const [tbl, usageMap] of tableColumnsUsage) {
      const keptCols = [...usageMap].filter(([, usage]) => usage >= this.minColumnUsage).map(([column]) => column);
      if (keptCols.length > 0) {
        tableColumns.set(tbl, keptCols);
      }
    }

    const candidates: IndexRecommendation[] = [];
    for (const [table, colList] of tableColumns) {
      // Every combination of the columns is generated, up to maxIndexWidth wide
      const maxWidth = Math.min(this.maxIndexWidth, colList.length);
      for (let width = 1; width <= maxWidth; width += 1) {
        for (const combo of combinations(colList, width)) {
          candidates.push(new IndexRecommendation(table, combo));
        }
      }
    }

    // filter out duplicates with existing indexes
    const filteredCandidates = candidates.filter((c) => !this.indexExists(c, existingDefs));

    // filter out candidates with columns not used in query conditions
    const conditionFiltered1 = this.filterCandidatesByQueryConditions(workload, filteredCandidates);

    // filter out long text columns
    const conditionFiltered = await this.filterLongTextColumns(conditionFiltered1);

    this.dtaTrace(`Generated ${candidates.length} total candidates`);
    this.dtaTrace(`Filtered to ${filteredCandidates.length} after removing existing indexes.`);
    this.dtaTrace(`Filtered to ${conditionFiltered1.length} after removing unused columns.`);
    this.dtaTrace(`Filtered to ${conditionFiltered.length} after removing long text columns.`);
    await this.storeHypotheticalSizes(conditionFiltered);
    return conditionFiltered;
  }

  /** table -> {column -> number of queries using it} */
  private countColumnUsage(workload: readonly QueryWeight[]): Map<string, Map<string, number>> {
    const tableColumnsUsage = new Map<string, Map<string, number>>();
    for (const [, stmt] of workload) {
      const columnsPerTable = this.sqlBindParams.extractStmtColumns(stmt);
      for (const [tbl, cols] of columnsPerTable) {
        let usage = tableColumnsUsage.get(tbl);
        if (!usage) {
          usage = new Map();
          tableColumnsUsage.set(tbl, usage);
        }
        for (const c of cols) {
          usage.set(c, (usage.get(c) ?? 0) + 1);
        }
      }
    }
    return tableColumnsUsage;
  }

  /** Batch create all hypothetical indexes and store their size estimates. */
  private async storeHypotheticalSizes(candidates: readonly IndexRecommendation[]): Promise<void> {
    if (candidates.length === 0) {
      return;
    }
    const query = 'SELECT hypopg_create_index({});'.repeat(candidates.length);
    await SafeSqlDriver.executeParamQuery(
      this.sqlDriver,
      query,
      candidates.map((idx) => idx.definition)
    );

    // Get estimated sizes without resetting indexes yet
    const result = await queryRows(
      this.sqlDriver,
      'SELECT index_name, hypopg_relation_size(indexrelid) as index_size FROM hypopg_list_indexes;'
    );
    const indexMap = new Map(result.map((r) => [cell.text(r, 'index_name'), cell.integer(r, 'index_size')]));
    for (const idx of candidates) {
      const size = indexMap.get(idx.name);
      if (size !== undefined) {
        idx.estimatedSizeBytes = size;
      }
    }

    await queryRows(this.sqlDriver, 'SELECT hypopg_reset();');
  }

  /**
   * Pareto optimal greedy approach using cost/benefit analysis:
   * - Cost: size of the base relations plus the size of the indexes (in bytes)
   * - Benefit: inverse of query execution time (1/time)
   * - Objective function: log(time) + alpha * log(space), to be minimized,
   *   with alpha=2 for 2x emphasis on space
   * - Primary stopping criterion: minimum relative time improvement threshold
   */
  async enumerateGreedy(
    queries: readonly QueryWeight[],
    currentIndexes: Set<IndexRecommendation>,
    currentCost: number,
    candidateIndexes: Set<IndexRecommendation>
  ): Promise<IndexConfiguration> {
    const alpha = this.paretoAlpha;
    const { minTimeImprovement } = this;

    this.dtaTrace('\n[GREEDY SEARCH] Starting enumeration');
    this.dtaTrace(`  - Parameters: alpha=${pyFloatStr(alpha)}, min_time_improvement=${pyFloatStr(minTimeImprovement)}`);
    this.dtaTrace(`  - Initial indexes: ${currentIndexes.size}, Candidates: ${candidateIndexes.size}`);

    // The tables involved in this analysis
    const tables = new Set<string>();
    for (const idx of candidateIndexes) {
      tables.add(idx.table);
    }

    // Estimate base relation size for each table
    let baseRelationSize = 0;
    for (const table of tables) {
      baseRelationSize += await this.getTableSize(table);
    }

    this.dtaTrace(`  - Base relation size: ${naturalSize(baseRelationSize)}`);

    // Calculate current indexes size
    const indexesSize = await this.sumIndexSizes(currentIndexes);

    // Total space is base relation plus indexes
    let currentSpace = baseRelationSize + indexesSize;
    let currentTime = currentCost;
    let currentObjective =
      currentCost > 0 && currentSpace > 0 ? pyLog(currentTime) + alpha * pyLog(currentSpace) : Number.POSITIVE_INFINITY;

    this.dtaTrace(
      `  - Initial configuration: Time=${formatFixed(currentTime, 2)}, ` +
        `Space=${naturalSize(currentSpace)} (Base: ${naturalSize(baseRelationSize)}, ` +
        `Indexes: ${naturalSize(indexesSize)}), ` +
        `Objective=${formatFixed(currentObjective, 4)}`
    );

    const addedIndexes: IndexRecommendation[] = [];
    let iteration = 1;

    // Exits through the stopping criteria inside the loop.
    while (true) {
      this.dtaTrace(`\n[ITERATION ${iteration}] Evaluating candidates`);
      let bestIndex: IndexRecommendation | undefined;
      let bestTime = currentTime;
      let bestSpace = currentSpace;
      let bestObjective = currentObjective;
      let bestTimeImprovement = 0;

      for (const candidate of candidateIndexes) {
        this.dtaTrace(`Evaluating candidate: ${candidateStr([candidate])}`);
        // Additional size from this index
        const indexSize = await this.estimateIndexSize(candidate.table, candidate.columns);
        this.dtaTrace(`    + Index size: ${naturalSize(indexSize)}`);
        // Total space with this index = current space + new index size
        const testSpace = currentSpace + indexSize;
        this.dtaTrace(`    + Total space: ${naturalSize(testSpace)}`);

        // Check budget constraint
        if (this.exceedsBudget(testSpace - baseRelationSize)) {
          this.dtaTrace(
            `  - Skipping candidate: ${candidateStr([candidate])} because total ` +
              `index size (${naturalSize(testSpace - baseRelationSize)}) exceeds ` +
              `budget (${naturalSize(this.budgetMb * MEGABYTE)})`
          );
          continue;
        }

        // New time (cost) with this index
        const testTime = await this.evaluateConfigurationCost(
          queries,
          [...currentIndexes, candidate].map((idx) => idx.indexDefinition)
        );
        this.dtaTrace(`    + Eval cost (time): ${pyFloatStr(testTime)}`);

        // Relative time improvement
        const timeImprovement = pyDivide(currentTime - testTime, currentTime);

        // Skip if time improvement is below threshold
        if (timeImprovement < minTimeImprovement) {
          this.dtaTrace(
            `  - Skipping candidate: ${candidateStr([candidate])} because time improvement is below threshold`
          );
          continue;
        }

        const testObjective = pyLog(testTime) + alpha * pyLog(testSpace);

        // Select the index with the best time improvement that meets our threshold
        if (testObjective < bestObjective && timeImprovement > bestTimeImprovement) {
          this.dtaTrace(`  - Updating best candidate: ${candidateStr([candidate])}`);
          bestIndex = candidate;
          bestTime = testTime;
          bestSpace = testSpace;
          bestObjective = testObjective;
          bestTimeImprovement = timeImprovement;
        } else {
          this.dtaTrace(
            `  - Skipping candidate: ${candidateStr([candidate])} because it doesn't have the best objective improvement`
          );
        }
      }

      // If no improvement or no valid candidates, stop
      if (bestIndex === undefined) {
        this.dtaTrace(`STOPPED SEARCH: No indexes found with time improvement >= ${formatPercent(minTimeImprovement)}`);
        break;
      }

      const timeImprovement = pyDivide(currentTime - bestTime, currentTime);
      const spaceIncrease = pyDivide(bestSpace - currentSpace, currentSpace);
      const objectiveImprovement = currentObjective - bestObjective;

      this.dtaTrace(
        `  - Selected index: ${candidateStr([bestIndex])}` +
          `\n    + Time improvement: ${formatPercent(timeImprovement)}` +
          `\n    + Space increase: ${formatPercent(spaceIncrease)}` +
          `\n    + New objective: ${formatFixed(bestObjective, 4)} (improvement: ${formatFixed(objectiveImprovement, 4)})`
      );

      // Add the best index and update metrics
      currentIndexes.add(bestIndex);
      candidateIndexes.delete(bestIndex);
      addedIndexes.push(bestIndex);

      currentTime = bestTime;
      currentSpace = bestSpace;
      currentObjective = bestObjective;

      iteration += 1;

      // Check the time limit after doing at least one iteration
      if (this.checkTime()) {
        this.dtaTrace('STOPPED SEARCH: Time limit reached');
        break;
      }
    }

    await this.traceSearchComplete(addedIndexes.length, currentIndexes, {
      baseRelationSize,
      currentObjective,
      currentSpace,
      currentTime,
    });

    return [currentIndexes, currentTime];
  }

  private exceedsBudget(indexBytes: number): boolean {
    return this.budgetMb > 0 && indexBytes > this.budgetMb * MEGABYTE;
  }

  private async traceSearchComplete(
    addedCount: number,
    currentIndexes: Iterable<IndexRecommendation>,
    state: {
      baseRelationSize: number;
      currentObjective: number;
      currentSpace: number;
      currentTime: number;
    }
  ): Promise<void> {
    this.dtaTrace('\n[SEARCH COMPLETE]');
    if (addedCount === 0) {
      this.dtaTrace('No indexes added - baseline configuration is optimal');
      return;
    }
    const indexesSize = await this.sumIndexSizes(currentIndexes);
    this.dtaTrace(
      `  - Final configuration: ${addedCount} indexes added` +
        `\n    + Final time: ${formatFixed(state.currentTime, 2)}` +
        `\n    + Final space: ${naturalSize(state.currentSpace)} (Base: ${naturalSize(state.baseRelationSize)}, ` +
        `Indexes: ${naturalSize(indexesSize)})` +
        `\n    + Final objective: ${formatFixed(state.currentObjective, 4)}`
    );
  }

  private async sumIndexSizes(indexes: Iterable<IndexRecommendation>): Promise<number> {
    let total = 0;
    for (const idx of indexes) {
      total += await this.estimateIndexSize(idx.table, idx.columns);
    }
    return total;
  }

  /** Filter out index candidates that contain columns not used in query conditions. */
  filterCandidatesByQueryConditions(
    workload: readonly QueryWeight[],
    candidates: IndexRecommendation[]
  ): IndexRecommendation[] {
    if (workload.length === 0 || candidates.length === 0) {
      return candidates;
    }

    // Columns used in conditions across all queries, by table
    const conditionColumns = new Map<string, Set<string>>();

    for (const [, stmt] of workload) {
      const collector = new ConditionColumnCollector();
      collector.visit(stmt);

      for (const [table, cols] of collector.conditionColumns) {
        let merged = conditionColumns.get(table);
        if (!merged) {
          merged = new Set();
          conditionColumns.set(table, merged);
        }
        for (const col of cols) {
          merged.add(col);
        }
      }
    }

    // Keep only candidates where all columns are used in conditions
    return candidates.filter((candidate) => {
      const used = conditionColumns.get(candidate.table);
      return used !== undefined && candidate.columns.every((col) => used.has(col));
    });
  }

  /**
   * Filter out indexes that contain long text columns based on catalog
   * information. `maxTextLength` is the maximum allowed text length.
   */
  async filterLongTextColumns(candidates: IndexRecommendation[], maxTextLength = 100): Promise<IndexRecommendation[]> {
    if (candidates.length === 0) {
      return [];
    }

    // The unique table.column combinations
    const tableColumns = new Map<string, [string, string]>();
    for (const candidate of candidates) {
      for (const column of candidate.columns) {
        tableColumns.set(pairKey(candidate.table, column), [candidate.table, column]);
      }
    }

    const pairs = [...tableColumns.values()];
    const tablesArray = pairs.map(([table]) => literal(table)).join(',');
    const columnsArray = pairs.map(([, col]) => literal(col)).join(',');

    // Column types and their length limits from the catalog
    const typeQuery = `
            SELECT
                c.table_name,
                c.column_name,
                c.data_type,
                c.character_maximum_length,
                pg_stats.avg_width,
                CASE
                    WHEN c.data_type = 'text' THEN true
                    WHEN (c.data_type = 'character varying' OR c.data_type = 'varchar' OR
                         c.data_type = 'character' OR c.data_type = 'char') AND
                         (c.character_maximum_length IS NULL OR c.character_maximum_length > ${maxTextLength})
                    THEN true
                    ELSE false
                END as potential_long_text
            FROM information_schema.columns c
            LEFT JOIN pg_stats ON
                pg_stats.tablename = c.table_name AND
                pg_stats.attname = c.column_name
            WHERE c.table_name IN (${tablesArray})
            AND c.column_name IN (${columnsArray})
        `;

    const result = (await queryRows(this.sqlDriver, typeQuery)).map(toLongTextRow);

    if (result.length === 0) {
      return [];
    }

    // Identify problematic columns
    const problematicColumns = new Set<string>();
    const potentialProblematicColumns = new Set<string>();

    for (const row of result) {
      const key = pairKey(row.tableName, row.columnName);
      const kind = classifyLongText(row, maxTextLength);
      if (kind === 'problematic') {
        problematicColumns.add(key);
      } else if (kind === 'potential') {
        potentialProblematicColumns.add(key);
      }
    }

    // Filter candidates based on column information
    return candidates.filter((candidate) => {
      const keys = candidate.columns.map((column) => pairKey(candidate.table, column));
      const firstProblem = keys.findIndex((key) => problematicColumns.has(key));
      // Columns before a problematic one still mark the candidate as potentially problematic
      const examined = firstProblem === -1 ? keys : keys.slice(0, firstProblem);
      if (examined.some((key) => potentialProblematicColumns.has(key))) {
        candidate.potentialProblematicReason = 'long_text_column';
      }
      return firstProblem === -1;
    });
  }

  /** Get all existing indexes. */
  async getExistingIndexes(): Promise<ExistingIndex[]> {
    // TODO: we should get the indexes that are relevant to the query
    const query = `
        SELECT schemaname as schema,
               tablename as table,
               indexname as name,
               indexdef as definition
        FROM pg_indexes
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY schemaname, tablename, indexname
        `;
    const result = await queryRows(this.sqlDriver, query);
    return result.map(toExistingIndex);
  }

  /**
   * Check if an index with the same table, columns, and type already exists in
   * the database, by parsing the index definitions and comparing their
   * structure. The parser must be loaded (`loadParser()`) beforehand.
   */
  indexExists(index: IndexRecommendation, existingDefs: ReadonlySet<string>): boolean {
    const candidateInfo = this.extractIndexInfo(DatabaseTuningAdvisor.parseFirstStatement(index.definition));

    for (const existingDef of existingDefs) {
      // Skip if it's obviously not an index
      const upper = existingDef.toUpperCase();
      if (!(upper.includes('CREATE INDEX') || upper.includes('CREATE UNIQUE INDEX'))) {
        continue;
      }

      const existingInfo = this.extractIndexInfo(DatabaseTuningAdvisor.parseFirstStatement(existingDef));

      if (this.isSameIndex(candidateInfo, existingInfo)) {
        return true;
      }
    }

    return false;
  }

  private static parseFirstStatement(sql: string): AstNode | undefined {
    const [first] = parseSqlSync(sql).stmts;
    if (!first) {
      throw new Error('No statement found');
    }
    return AstNode.from(first.stmt);
  }

  /** Extract key information from a parsed index node. */
  extractIndexInfo(node: AstNode | undefined): IndexInfo {
    if (!node?.is('IndexStmt')) {
      throw new TypeError(`Not an index statement: ${node?.type}`);
    }

    // `relation` is a bare RangeVar struct
    const relationJson = node.fields.relation;
    const relation = isJsonObject(relationJson)
      ? (AstNode.from(relationJson) ?? new AstNode('RangeVar', relationJson))
      : undefined;
    const tableName = relation?.string('relname');
    if (tableName === undefined) {
      throw new TypeError('Index statement has no table name');
    }

    const columns: string[] = [];
    for (const idxElem of node.nodes('indexParams')) {
      const name = idxElem.string('name');
      const expr = idxElem.node('expr');
      if (name) {
        columns.push(name);
      } else if (expr) {
        // The expression becomes a string such as "lower(name)"
        columns.push(this.astExprToString(expr));
      }
    }

    return {
      table: tableName.toLowerCase(),
      columns: columns.map((col) => col.toLowerCase()),
      // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- an empty access method falls back to btree, as upstream's `or` does
      type: (node.string('accessMethod') || 'btree').toLowerCase(),
      unique: node.fields.unique === true,
    };
  }

  /** Convert an AST expression (like FuncCall) to a string, e.g. "lower(name)". */
  astExprToString(expr: AstNode): string {
    if (expr.is('FuncCall')) {
      const names = stringList(expr, 'funcname');
      const funcName = names.length > 0 ? names.join('.') : 'unknown_func';
      const args = expr.nodes('args').map((arg) => this.astExprToString(arg));
      return `${funcName}(${args.join(',')})`;
    }
    if (expr.is('ColumnRef')) {
      const fields = stringList(expr, 'fields');
      return fields.length > 0 ? fields.join('.') : 'unknown_column';
    }
    if (expr.is('A_Const')) {
      const sval = expr.node('sval')?.string('sval');
      if (sval !== undefined) {
        return sval;
      }
      const { ival } = expr.fields;
      if (isJsonObject(ival)) {
        // libpg-query omits ival.ival when the integer is 0
        return typeof ival.ival === 'number' ? String(ival.ival) : '0';
      }
      const { fval } = expr.fields;
      if (isJsonObject(fval) && typeof fval.fval === 'string') {
        return fval.fval;
      }
    }
    // Other expressions never equal a plain column name
    return `<${expr.type}>`;
  }

  /** Check if two indexes are functionally equivalent. */
  isSameIndex(index1: IndexInfo, index2: IndexInfo): boolean {
    if (index1.table !== index2.table) {
      return false;
    }

    if (index1.type !== index2.type) {
      return false;
    }

    // Same columns (order matters for most index types)?
    const sameColumns =
      index1.columns.length === index2.columns.length && index1.columns.every((col, i) => col === index2.columns[i]);
    if (!sameColumns) {
      // For hash indexes, order doesn't matter
      return (
        index1.type === 'hash' &&
        new Set(index1.columns).size === new Set(index2.columns).size &&
        index1.columns.every((col) => index2.columns.includes(col))
      );
    }

    // If one is unique and the other is not, they're different
    return !(index1.unique && !index2.unique);
  }
}

interface ColumnAliasInfo {
  level: number;
  node: AstNode | undefined;
}

interface ConditionScope {
  aliases: ReadonlyMap<string, string>;
  tables: ReadonlySet<string>;
}

/**
 * A specialized version of ColumnCollector that only collects columns used in
 * WHERE, JOIN, HAVING and ORDER BY conditions, and resolves column aliases.
 *
 * It keeps its own scope and alias state: the inherited visitors only act
 * while the base collector is inside a SELECT, which this class never enters,
 * and the breadth-first walk reaches every node they would visit anyway.
 */
export class ConditionColumnCollector extends ColumnCollector {
  /** Columns used in conditions, by table. */
  readonly conditionColumns = new Map<string, Set<string>>();
  inCondition: boolean;
  private readonly conditionScopes: ConditionScope[] = [];
  readonly conditionAliases = new Map<string, ColumnAliasInfo>();
  private conditionQueryLevel = 0;

  constructor() {
    super();
    this.inCondition = false;
  }

  /**
   * Visit a SelectStmt node, focusing on condition-related clauses while still
   * collecting column aliases.
   */
  override visitSelectStmt(_ancestors: readonly AstNode[], node: AstNode): void {
    this.conditionQueryLevel += 1;
    const queryLevel = this.conditionQueryLevel;

    // Get table aliases first
    const aliasVisitor = new TableAliasVisitor();
    const fromClause = node.nodes('fromClause');
    for (const fromItem of fromClause) {
      aliasVisitor.visit(fromItem);
    }
    this.conditionScopes.push({
      tables: aliasVisitor.tables,
      aliases: aliasVisitor.aliases,
    });

    // First pass: collect column aliases from targetList
    for (const targetEntry of node.nodes('targetList')) {
      const colAlias = targetEntry.string('name');
      if (colAlias) {
        this.conditionAliases.set(colAlias, {
          node: targetEntry.node('val'),
          level: queryLevel,
        });
      }
    }

    // Process WHERE clause
    const whereClause = node.node('whereClause');
    if (whereClause) {
      this.inConditionDo(() => {
        this.visit(whereClause);
      });
    }

    // Process JOIN conditions in fromClause
    for (const item of fromClause) {
      const quals = item.is('JoinExpr') ? item.node('quals') : undefined;
      if (quals) {
        this.inConditionDo(() => {
          this.visit(quals);
        });
      }
    }

    // Process HAVING clause, which may reference aliases
    const havingClause = node.node('havingClause');
    if (havingClause) {
      this.inConditionDo(() => {
        this.processNodeWithAliases(havingClause);
      });
    }

    // Process ORDER BY clause, also important for indexes
    const sortClause = node.nodes('sortClause');
    if (sortClause.length > 0) {
      this.inConditionDo(() => {
        for (const sortItem of sortClause) {
          this.processNodeWithAliases(sortItem.node('node'));
        }
      });
    }

    // GROUP BY is deliberately not treated as a condition.

    this.conditionScopes.pop();
    this.conditionQueryLevel -= 1;
  }

  private inConditionDo(action: () => void): void {
    const cached = this.inCondition;
    this.inCondition = true;
    action();
    this.inCondition = cached;
  }

  /** Process a node, resolving any column aliases it contains. */
  processNodeWithAliases(node: AstNode | undefined): void {
    if (!node) {
      return;
    }

    // If the node is a column reference, it might be an alias
    if (node.is('ColumnRef')) {
      const fields = stringList(node, 'fields');
      const [colName] = fields;
      if (fields.length === 1 && colName !== undefined) {
        const aliasInfo = this.conditionAliases.get(colName);
        // Process the original expression instead
        if (aliasInfo && aliasInfo.level === this.conditionQueryLevel) {
          this.visit(aliasInfo.node);
          return;
        }
      }
    }

    this.visit(node);
  }

  /**
   * Process column references, but only in a condition context. A reference to
   * a column alias processes the aliased expression instead.
   */
  override visitColumnRef(_ancestors: readonly AstNode[], node: AstNode): void {
    if (!this.inCondition) {
      return;
    }

    const scope = this.conditionScopes.at(-1);
    if (!scope) {
      return;
    }

    const fields = stringList(node, 'fields');
    const [first, second] = fields;

    // Check if this is a reference to a column alias
    if (fields.length === 1 && first !== undefined) {
      const aliasInfo = this.conditionAliases.get(first);
      if (aliasInfo) {
        if (aliasInfo.level === this.conditionQueryLevel) {
          this.inCondition = true;
          this.visit(aliasInfo.node);
        }
        return;
      }
    }

    if (fields.length === 2 && first !== undefined && second !== undefined) {
      // Table.column format: resolve alias to the actual table
      this.addConditionColumn(scope.aliases.get(first) ?? first, second);
    } else if (fields.length === 1 && first !== undefined) {
      // Unqualified column: it is attributed to every table in scope, as the
      // column existence check is not backed by the catalog.
      for (const scopeTable of scope.tables) {
        // Skip schema qualification if present
        const dot = scopeTable.indexOf('.');
        const table = dot === -1 ? scopeTable : scopeTable.slice(dot + 1);
        this.addConditionColumn(table, first);
      }
    }
  }

  private addConditionColumn(table: string, column: string): void {
    let columns = this.conditionColumns.get(table);
    if (!columns) {
      columns = new Set();
      this.conditionColumns.set(table, columns);
    }
    columns.add(column);
  }
}
