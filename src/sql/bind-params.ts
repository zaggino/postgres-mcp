import { pyFloatStr } from '../py-format.ts';
import { literal } from './literal.ts';
import { AstNode, isJsonObject, parseSql, Visitor } from './pg-ast.ts';
import type { SqlExecutor } from './safe-sql.ts';
import { SafeSqlDriver } from './safe-sql.ts';

function logWarning(message: string): void {
  process.stderr.write(`${message}\n`);
}

function logError(message: string): void {
  process.stderr.write(`${message}\n`);
}

// --- Visitor classes ---

/** Extracts table aliases and names from the SQL AST. */
export class TableAliasVisitor extends Visitor {
  readonly aliases = new Map<string, string>();
  readonly tables = new Set<string>();

  /** Visit table references, including those in FROM clause. */
  visitRangeVar(_ancestors: readonly AstNode[], node: AstNode): void {
    const relname = node.string('relname');
    if (relname !== undefined) {
      this.tables.add(relname);
    }
    const aliasname = node.node('alias')?.string('aliasname');
    if (aliasname !== undefined) {
      this.aliases.set(aliasname, relname ?? 'None');
    }
  }

  /** Visit both sides of JOIN expressions. */
  visitJoinExpr(_ancestors: readonly AstNode[], node: AstNode): void {
    this.visit(node.node('larg'));
    this.visit(node.node('rarg'));
  }
}

interface Scope {
  aliases: ReadonlyMap<string, string>;
  tables: ReadonlySet<string>;
}

interface ColumnAlias {
  level: number;
  node: AstNode | undefined;
}

function scopeOf(root: AstNode | AstNode[] | undefined): Scope {
  const aliasVisitor = new TableAliasVisitor();
  aliasVisitor.visit(root);
  return { tables: aliasVisitor.tables, aliases: aliasVisitor.aliases };
}

/**
 * Collects columns used in WHERE, JOIN, ORDER BY, GROUP BY, HAVING, and SELECT
 * clauses, with handling of column aliases.
 */
export class ColumnCollector extends Visitor {
  /** Collected columns, keyed by table. */
  readonly columns = new Map<string, Set<string>>();
  private readonly contextStack: Scope[] = [];
  private insideSelect: boolean;
  private readonly columnAliases = new Map<string, ColumnAlias>();
  private currentQueryLevel: number;

  constructor() {
    super();
    this.insideSelect = false;
    this.currentQueryLevel = 0;
  }

  /** Visit a SelectStmt node and process its targetList for column aliases. */
  visitSelectStmt(_ancestors: readonly AstNode[], node: AstNode): void {
    this.insideSelect = true;
    this.currentQueryLevel += 1;
    const queryLevel = this.currentQueryLevel;

    // Collect tables and aliases
    const aliasVisitor = new TableAliasVisitor();
    for (const fromItem of node.nodes('fromClause')) {
      aliasVisitor.visit(fromItem);
    }
    this.contextStack.push({
      tables: aliasVisitor.tables,
      aliases: aliasVisitor.aliases,
    });

    // First pass: collect column aliases from targetList
    for (const targetEntry of node.nodes('targetList')) {
      const colAlias = targetEntry.string('name');
      if (colAlias) {
        this.columnAliases.set(colAlias, {
          node: targetEntry.node('val'),
          level: queryLevel,
        });
      }
    }

    // Second pass: process the rest of the query
    this.processQueryClauses(node);

    this.contextStack.pop();
    this.insideSelect = false;
    this.currentQueryLevel -= 1;
  }

  private processQueryClauses(node: AstNode): void {
    for (const targetEntry of node.nodes('targetList')) {
      this.visit(targetEntry.node('val'));
    }

    this.visit(node.node('whereClause'));

    for (const fromItem of node.nodes('fromClause')) {
      this.visit(fromItem);
    }

    this.visit(node.node('havingClause'));

    for (const sortItem of node.nodes('sortClause')) {
      this.processSortItem(sortItem);
    }
  }

  /** Process a sort item, resolving column aliases if needed. */
  private processSortItem(sortItem: AstNode): void {
    const sortNode = sortItem.node('node');
    if (sortNode?.is('ColumnRef')) {
      const fields = sortNode
        .nodes('fields')
        .filter((field) => field.is('String'))
        .map((field) => field.string('sval') ?? '');
      const [colName] = fields;
      if (fields.length === 1 && colName !== undefined) {
        const aliasInfo = this.columnAliases.get(colName);
        if (aliasInfo && aliasInfo.level === this.currentQueryLevel) {
          this.visit(aliasInfo.node);
          return;
        }
      }
    }
    this.visit(sortNode);
  }

  /** Visit a ColumnRef node and collect column names, skipping aliases. */
  visitColumnRef(_ancestors: readonly AstNode[], node: AstNode): void {
    if (!this.insideSelect) {
      return;
    }
    const refFields = node.nodes('fields');
    if (refFields.length === 0) {
      return;
    }
    const fields = refFields.map((field) => (field.is('String') ? (field.string('sval') ?? '') : '*'));

    // Skip collecting if this is a reference to a column alias
    const [first, second] = fields;
    if (fields.length === 1 && first !== undefined && (first === '*' || this.columnAliases.has(first))) {
      return;
    }
    if (fields.length === 2 && second === '*') {
      return;
    }

    const scope = this.contextStack.at(-1) ?? {
      tables: new Set<string>(),
      aliases: new Map<string, string>(),
    };

    if (fields.length === 2 && first !== undefined && second !== undefined) {
      // Qualified column (e.g., u.name)
      this.addColumn(scope.aliases.get(first) ?? first, second);
    } else if (fields.length === 1 && first !== undefined) {
      // Unqualified column. Python's `_column_exists` placeholder always
      // answers yes, so with several tables the first one claims the column.
      const [table] = scope.tables;
      if (table !== undefined) {
        this.addColumn(table, first);
      }
    }
  }

  private addColumn(table: string, column: string): void {
    let columns = this.columns.get(table);
    if (!columns) {
      columns = new Set<string>();
      this.columns.set(table, columns);
    }
    columns.add(column);
  }

  /** Visit an A_Expr node (arithmetic or comparison expression). */
  visitAExpr(_ancestors: readonly AstNode[], node: AstNode): void {
    if (!this.insideSelect) {
      return;
    }
    const lexpr = node.operand('lexpr');
    if (lexpr) {
      this.visit(lexpr);
      if (lexpr instanceof AstNode && lexpr.is('SelectStmt')) {
        this.visitInScope(lexpr);
      }
    }

    const rexpr = node.operand('rexpr');
    if (rexpr) {
      if (rexpr instanceof AstNode && rexpr.is('SelectStmt')) {
        this.visitInScope(rexpr);
      } else {
        this.visit(rexpr);
      }
    }

    // The Python source compares `kind == 0` (its comment says IN), which is
    // AEXPR_OP; the behaviour is kept.
    if (node.string('kind') === 'AEXPR_OP' && rexpr instanceof AstNode && rexpr.is('SelectStmt')) {
      this.visitInScope(rexpr);
    }
  }

  private visitInScope(subquery: AstNode): void {
    this.contextStack.push(scopeOf(subquery));
    this.visit(subquery);
    this.contextStack.pop();
  }

  /** Visit a JoinExpr node to handle JOIN conditions. */
  visitJoinExpr(_ancestors: readonly AstNode[], node: AstNode): void {
    if (!this.insideSelect) {
      return;
    }
    this.visit(node.node('larg'));
    this.visit(node.node('rarg'));
    this.visit(node.node('quals'));
  }

  /** Visit a SortBy node (ORDER BY expression). */
  visitSortBy(_ancestors: readonly AstNode[], node: AstNode): void {
    if (this.insideSelect) {
      this.visit(node.node('node'));
    }
  }
}

// --- Parameter replacement ---

/** A pg_stats array element that Python parsed as a float. */
export class PgFloat {
  readonly value: number;

  constructor(value: number) {
    this.value = value;
  }

  toString(): string {
    return pyFloatStr(this.value);
  }
}

type StatValue = string | number | bigint | PgFloat | null;

/** SQL text written by this module, not read from the database. */
interface ReadySql {
  readonly sql: string;
}
type Bound = StatValue | ReadySql;
type ColumnStats = Record<string, unknown>;
type TableColumns = ReadonlyMap<string, Iterable<string>>;

const INT_PATTERN = /^[+-]?\d+$/u;
const FLOAT_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu;
const DIGITS_PATTERN = /^\d+$/u;
const PARAM_PATTERN = /\$\d+/gu;
const HAS_PARAM_PATTERN = /\$\d+/u;
const WHITESPACE_PATTERN = /\s+/u;
const ARRAY_BRACES_PATTERN = /^[{}]+|[{}]+$/gu;
const BETWEEN_PATTERN = /(?<column>\w+(?:\.\w+)?)\s+between\s+\$(?<first>\d+)\s+and\s+\$(?<second>\d+)/giu;
const EQUALS_PARAM_PATTERN = /(?<column>\w+)\s*=\s*\$\d+/gu;
const LESS_PARAM_PATTERN = /(?<column>\w+)\s*<\s*\$\d+/gu;
const GREATER_PARAM_PATTERN = /(?<column>\w+)\s*>\s*\$\d+/gu;

function hasParam(text: string): boolean {
  return HAS_PARAM_PATTERN.test(text);
}

/** Python's `str()` of a parsed array element. */
function pyStr(value: StatValue): string {
  return value === null ? 'None' : String(value);
}

/**
 * SQL text for a statistics value. Anything but a number comes from table data
 * and is quoted as a literal.
 */
function statSql(value: Bound): string {
  if (value === null) {
    return pyStr(value);
  }
  if (typeof value === 'string') {
    return literal(value);
  }
  if (typeof value === 'object' && 'sql' in value) {
    return value.sql;
  }
  return pyStr(value);
}

function toStatValue(value: unknown): StatValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof PgFloat || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : new PgFloat(value);
  }
  if (typeof value === 'bigint') {
    return value;
  }
  // oxlint-disable-next-line typescript/no-base-to-string -- stringified like upstream's str(); objects and arrays diverge, see docs/TODO.md
  return String(value);
}

function statList(value: unknown): StatValue[] | undefined {
  return Array.isArray(value) ? value.map(toStatValue) : undefined;
}

function statNumber(value: StatValue): number {
  if (value instanceof PgFloat) {
    return value.value;
  }
  return value === null ? Number.NaN : Number(value);
}

function dataTypeOf(stats: ColumnStats): string {
  const { data_type: dataType } = stats;
  return typeof dataType === 'string' ? dataType.toLowerCase() : '';
}

/** Python's `int(...)`/`float(...)` attempt on a hand-split array element. */
function parsePgArrayValue(raw: string): StatValue {
  const value = raw.trim();
  if (value === 'null') {
    return null;
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  if (value.includes('.')) {
    return FLOAT_PATTERN.test(value) ? new PgFloat(Number(value)) : value;
  }
  if (!INT_PATTERN.test(value)) {
    return value;
  }
  // Python ints are exact; keep what a double cannot hold as a bigint.
  const asNumber = Number(value);
  return Number.isSafeInteger(asNumber) ? asNumber : BigInt(value);
}

function includesAny(text: string, needles: readonly string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

/** `replace` with a callback that receives the pattern's named groups. */
function replaceWithGroups(
  text: string,
  pattern: RegExp,
  replacer: (groups: Readonly<Record<string, string | undefined>>) => string
): string {
  return text.replace(pattern, (...args: unknown[]) => {
    const groups: Record<string, string | undefined> = {};
    const last = args.at(-1);
    if (isJsonObject(last)) {
      for (const [name, value] of Object.entries(last)) {
        groups[name] = typeof value === 'string' ? value : undefined;
      }
    }
    return replacer(groups);
  });
}

/** Replace parameters based on column name context. */
function contextReplace(colName: string, op: string): string {
  const name = colName.toLowerCase();
  if (name.endsWith('id')) {
    return `${name} ${op} 46`;
  }
  if (includesAny(name, ['date', 'time', 'created', 'updated'])) {
    return `${name} ${op} '2023-01-01'`;
  }
  if (includesAny(name, ['amount', 'price', 'cost', 'count', 'num', 'qty'])) {
    return `${name} ${op} 46.5`;
  }
  if (includesAny(name, ['status', 'type', 'state'])) {
    return `${name} ${op} 'active'`;
  }
  return `${name} ${op} 'sample_value'`;
}

/** Fallback generic parameter replacement when catalog lookup fails. */
function replaceParametersGeneric(query: string): string {
  const withEquals = replaceWithGroups(query.replaceAll(/like \$\d+/gu, "like '%'"), EQUALS_PARAM_PATTERN, (groups) =>
    contextReplace(groups.column ?? '', '=')
  );
  const withLess = replaceWithGroups(withEquals, LESS_PARAM_PATTERN, (groups) =>
    contextReplace(groups.column ?? '', '<')
  );
  return replaceWithGroups(withLess, GREATER_PARAM_PATTERN, (groups) => contextReplace(groups.column ?? '', '>'))
    .replaceAll(/(?<num>\d+) and \$\d+/gu, '$<num> and 100')
    .replaceAll(/\$\d+ and (?<num>\d+)/gu, '1 and $<num>')
    .replaceAll(/>\s*\$\d+/gu, '> 1')
    .replaceAll(/<\s*\$\d+/gu, '< 100')
    .replaceAll(/[=]\s*\$\d+\b/gu, '= 45')
    .replaceAll(/\$\d+/gu, "'sample_value'");
}

/** The LIMIT / INTERVAL / OFFSET rewrites, in the order that prevents clashes. */
function replaceStaticPatterns(query: string): string {
  return (
    query
      // LIMIT clauses are always replaced with integers
      .replaceAll(/limit\s+\$\d+/giu, 'limit 100')
      // Static INTERVAL expressions
      .replaceAll(/interval\s+'\d+\s+(?<unit>[a-z]+)'/giu, "interval '2 $<unit>'")
      // Parameterized INTERVAL expressions (INTERVAL $1)
      .replaceAll(/interval\s+\$\d+/giu, "interval '2 days'")
      // OFFSET clauses
      .replaceAll(/offset\s+\$\d+/giu, 'offset 0')
  );
}

function adjustBound(value: number, isLower: boolean): number {
  const adjustment = value === 0 ? 1 : Math.abs(value) * 0.05;
  return isLower ? value - adjustment : value + adjustment;
}

/** A small +/- adjustment around the most common value. */
function commonValueBound(mostCommon: StatValue, isLower: boolean): StatValue {
  if (mostCommon instanceof PgFloat) {
    return new PgFloat(adjustBound(mostCommon.value, isLower));
  }
  // `int(float)` prints the exact value of the double, hence BigInt.
  if (typeof mostCommon === 'number' || typeof mostCommon === 'bigint') {
    return BigInt(Math.trunc(adjustBound(Number(mostCommon), isLower)));
  }
  if (typeof mostCommon === 'string' && DIGITS_PATTERN.test(mostCommon)) {
    return String(BigInt(Math.trunc(adjustBound(Number(mostCommon), isLower))));
  }
  return mostCommon;
}

/** Stay within 10% of the median histogram bound in either direction. */
function histogramBound(bounds: StatValue[], isLower: boolean): StatValue {
  const medianIdx = Math.floor(bounds.length / 2);
  const idxOffset = Math.max(1, Math.floor(bounds.length / 10));
  const boundIdx = isLower ? Math.max(0, medianIdx - idxOffset) : Math.min(bounds.length - 1, medianIdx + idxOffset);
  return bounds[boundIdx] ?? null;
}

/** Very conservative defaults as a last resort. */
function defaultBound(dataType: string, isLower: boolean): Bound {
  if (dataType.includes('int') || ['smallint', 'integer', 'bigint'].includes(dataType)) {
    return isLower ? 10 : 20;
  }
  if (['numeric', 'decimal', 'real', 'double precision', 'float'].includes(dataType)) {
    return new PgFloat(isLower ? 10 : 20);
  }
  if (dataType.includes('date') || dataType.includes('time')) {
    return { sql: isLower ? "'2023-01-01'" : "'2023-01-31'" };
  }
  if (dataType === 'boolean') {
    return { sql: 'true' };
  }
  return { sql: isLower ? "'m'" : "'n'" };
}

/** Tight bound values for range queries based on column statistics. */
function boundValues(stats: ColumnStats, isLower: boolean): Bound {
  // Most common values are statistically the most relevant
  const commonVals = statList(stats.common_vals);
  const commonFreqs = statList(stats.common_freqs);
  if (commonVals && commonFreqs && commonVals.length > 0 && commonVals.length === commonFreqs.length) {
    const freqs = commonFreqs.map(statNumber);
    const mostCommon = commonVals[freqs.indexOf(Math.max(...freqs))] ?? null;
    return commonValueBound(mostCommon, isLower);
  }

  // Next, try histogram bounds focusing on central values
  const histogramBounds = statList(stats.histogram_bounds);
  if (histogramBounds && histogramBounds.length >= 3) {
    return histogramBound(histogramBounds, isLower);
  }

  // Fall back to standard statistics if available
  const fallback = statList(stats.most_common_vals)?.[0] ?? null;
  if (fallback !== null) {
    return fallback;
  }

  return defaultBound(dataTypeOf(stats), isLower);
}

/** Aliases (including the table name itself) of a table in the query. */
async function getTableAliases(query: string, tableName: string): Promise<string[]> {
  try {
    const { stmts } = await parseSql(query);
    const [first] = stmts;
    if (!first) {
      return [tableName];
    }
    const aliasVisitor = new TableAliasVisitor();
    aliasVisitor.visit(AstNode.from(first.stmt));

    const aliases = [tableName];
    for (const [alias, table] of aliasVisitor.aliases) {
      if (table.toLowerCase() === tableName.toLowerCase()) {
        aliases.push(alias);
      }
    }
    return aliases;
  } catch (error) {
    logError(`Error extracting table aliases: ${String(error)}`);
    return [tableName];
  }
}

/** Column names are embedded unescaped; an invalid pattern is a non-match. */
function safeRegexTest(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern, 'iu').test(text);
  } catch {
    return false;
  }
}

/** The text from the nearest preceding clause boundary up to the parameter. */
function precedingContext(query: string, paramPosition: number): string {
  const before = query.slice(0, paramPosition);
  let clauseStart = Math.max(
    before.lastIndexOf(' where '),
    before.lastIndexOf(' and '),
    before.lastIndexOf(' or '),
    before.lastIndexOf(','),
    before.lastIndexOf('('),
    -1
  );
  if (clauseStart === -1) {
    clauseStart = Math.max(0, paramPosition - 100);
  }
  return query.slice(clauseStart, paramPosition + 2);
}

function stringReplacement(commonVals: StatValue[] | undefined, isLike: boolean): string {
  if (isLike) {
    return "'%test%'";
  }
  const [sample] = commonVals ?? [];
  if (commonVals && commonVals.length > 0) {
    return literal(pyStr(sample ?? null));
  }
  return "'sample_value'";
}

function numericReplacement(
  dataType: string,
  commonVals: StatValue[],
  histogramBounds: StatValue[],
  context: { isEquality: boolean; isRange: boolean }
): string {
  const first = (values: StatValue[]) => statSql(values[0] ?? null);
  if (histogramBounds.length > 0 && context.isRange) {
    // For range queries, use a value in the middle
    if (histogramBounds.length > 1) {
      const middle = histogramBounds[Math.floor(histogramBounds.length / 2)];
      return statSql(middle ?? null);
    }
  } else if (commonVals.length > 0 && context.isEquality) {
    return first(commonVals);
  } else if (histogramBounds.length > 0) {
    return first(histogramBounds);
  }
  return dataType.includes('int') ? '41' : '41.5';
}

const STATS_QUERY = `
            SELECT
                data_type,
                most_common_vals as common_vals,
                most_common_freqs as common_freqs,
                histogram_bounds,
                null_frac,
                n_distinct,
                correlation
            FROM pg_stats
            JOIN information_schema.columns
                ON pg_stats.tablename = information_schema.columns.table_name
                AND pg_stats.attname = information_schema.columns.column_name
            WHERE pg_stats.tablename = {}
            AND pg_stats.attname = {}
            `;

/** Replaces parameter placeholders with values based on column statistics. */
export class SqlBindParams {
  private readonly sqlDriver: SqlExecutor;
  private readonly columnStatsCache = new Map<string, ColumnStats | null>();

  constructor(sqlDriver: SqlExecutor) {
    this.sqlDriver = sqlDriver;
  }

  /**
   * Replace parameter placeholders with appropriate values based on column
   * statistics. This handles queries from pg_stat_statements where literals
   * have been replaced with $1, $2, etc.
   */
  async replaceParameters(query: string): Promise<string> {
    try {
      return await this.replaceParametersUnchecked(query);
    } catch (error) {
      throw new Error('Error replacing parameters', { cause: error });
    }
  }

  private async replaceParametersUnchecked(query: string): Promise<string> {
    if (!hasParam(query)) {
      return query;
    }

    const staticallyReplaced = replaceStaticPatterns(query);
    if (!hasParam(staticallyReplaced)) {
      return staticallyReplaced;
    }

    const modifiedQuery = await this.bindBetweenParams(query, staticallyReplaced);

    // Now handle remaining parameters normally
    const paramMatches = [...modifiedQuery.matchAll(PARAM_PATTERN)];
    if (paramMatches.length === 0) {
      return modifiedQuery;
    }

    const tableColumns = await this.extractColumns(query);
    if (tableColumns.size === 0) {
      return replaceParametersGeneric(modifiedQuery);
    }
    return await this.bindRemainingParams(modifiedQuery, paramMatches, tableColumns);
  }

  /** BETWEEN clauses are special cases: both bounds come from statistics. */
  private async bindBetweenParams(query: string, modifiedQuery: string): Promise<string> {
    let result = modifiedQuery;
    for (const match of query.matchAll(BETWEEN_PATTERN)) {
      const { column, first, second } = match.groups ?? {};
      if (!(column && first && second)) {
        continue;
      }
      const { tableName, colName } = await this.findBetweenColumn(query, column);

      // Default numeric bounds if statistics not available
      let lowerBound: Bound = 10;
      let upperBound: Bound = 100;
      if (tableName && colName) {
        const stats = await this.getColumnStatistics(tableName, colName);
        if (stats) {
          lowerBound = boundValues(stats, true);
          upperBound = boundValues(stats, false);
        }
      }

      // Replace both parameters in the BETWEEN clause
      const lower = statSql(lowerBound);
      const upper = statSql(upperBound);
      result = result
        .replaceAll(new RegExp(String.raw`\$${first}`, 'gu'), () => lower)
        .replaceAll(new RegExp(String.raw`\$${second}`, 'gu'), () => upper);
    }
    return result;
  }

  /** Resolves `alias.col` through the query's aliases, or `col` by its tables. */
  private async findBetweenColumn(
    query: string,
    columnRef: string
  ): Promise<{ colName: string; tableName: string | undefined }> {
    const tableColumns = await this.extractColumns(query);
    if (columnRef.includes('.')) {
      const [alias = '', colName = ''] = columnRef.split('.');
      const aliasLists = await Promise.all(
        [...tableColumns.keys()].map(async (tbl) => [tbl, await getTableAliases(query, tbl)] as const)
      );
      const found = aliasLists.find(([, aliases]) => aliases.includes(alias));
      return { tableName: found?.[0], colName };
    }
    for (const [tbl, cols] of tableColumns) {
      if ([...cols].includes(columnRef)) {
        return { tableName: tbl, colName: columnRef };
      }
    }
    return { tableName: undefined, colName: columnRef };
  }

  /** Replaces each remaining `$n`, last first so earlier positions stay valid. */
  private async bindRemainingParams(
    query: string,
    paramMatches: RegExpExecArray[],
    tableColumns: TableColumns
  ): Promise<string> {
    let modifiedQuery = query;
    for (const match of paramMatches.reverse()) {
      const precedingText = precedingContext(modifiedQuery, match.index);

      // Try to identify which column this parameter belongs to
      let replacement: string;
      const columnInfo = this.identifyParameterColumn(precedingText, tableColumns);
      if (columnInfo) {
        const [tableName, columnName] = columnInfo;
        const stats = await this.getColumnStatistics(tableName, columnName);
        replacement = stats
          ? this.getReplacementValue(stats, precedingText)
          : this.getGenericReplacement(precedingText);
      } else {
        replacement = this.getGenericReplacement(precedingText);
      }

      modifiedQuery =
        modifiedQuery.slice(0, match.index) + replacement + modifiedQuery.slice(match.index + match[0].length);
    }
    return modifiedQuery;
  }

  /** Identify which column a parameter likely belongs to based on context. */
  identifyParameterColumn(context: string, tableColumns: TableColumns): [string, string] | undefined {
    for (const [table, columns] of tableColumns) {
      for (const column of columns) {
        const patterns = [
          String.raw`${column}\s*=\s*\$\d+`,
          String.raw`${column}\s+in\s+\([^)]*\$\d+[^)]*\)`,
          String.raw`${column}\s+like\s+\$\d+`,
          String.raw`${column}\s*>\s*\$\d+`,
          String.raw`${column}\s*<\s*\$\d+`,
          String.raw`${column}\s*>=\s*\$\d+`,
          String.raw`${column}\s*<=\s*\$\d+`,
          String.raw`${column}\s+between\s+\$\d+\s+and\s+\$\d+`,
        ];
        if (patterns.some((pattern) => safeRegexTest(pattern, context))) {
          return [table, column];
        }
      }
    }
    return undefined;
  }

  /** Statistics for a column from pg_stats (cached, including misses). */
  async getColumnStatistics(tableName: string, columnName: string): Promise<ColumnStats | null> {
    const cacheKey = `${tableName}.${columnName}`;
    const cached = this.columnStatsCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    try {
      const result = await SafeSqlDriver.executeParamQuery(this.sqlDriver, STATS_QUERY, [tableName, columnName]);
      const row = result?.[0];
      if (!row) {
        this.columnStatsCache.set(cacheKey, null);
        return null;
      }

      const stats: ColumnStats = { ...row.cells };

      // Convert PostgreSQL array literals like '{val1,val2}' to lists
      for (const key of ['common_vals', 'common_freqs', 'histogram_bounds']) {
        const value = stats[key];
        if (typeof value === 'string') {
          const arrayStr = value.replaceAll(ARRAY_BRACES_PATTERN, '');
          stats[key] = arrayStr ? arrayStr.split(',').map(parsePgArrayValue) : [];
        }
      }

      this.columnStatsCache.set(cacheKey, stats);
      return stats;
    } catch (error) {
      logWarning(`Error getting column statistics for ${tableName}.${columnName}: ${String(error)}`);
      this.columnStatsCache.set(cacheKey, null);
      return null;
    }
  }

  /** A replacement value based on column statistics. */
  getReplacementValue(stats: ColumnStats, context: string): string {
    const dataType = dataTypeOf(stats);
    const commonVals = statList(stats.common_vals);
    const histogramBounds = statList(stats.histogram_bounds);

    // Detect query operator context
    const isEquality = context.includes('=') && !context.includes('!=') && !context.includes('<>');
    const isRange = includesAny(context, ['>', '<', '>=', '<=', 'between']);

    if (dataType.includes('char') || dataType === 'text') {
      return stringReplacement(commonVals, context.includes('like'));
    }
    if (dataType.includes('int') || ['numeric', 'decimal', 'real', 'double'].includes(dataType)) {
      return numericReplacement(dataType, commonVals ?? [], histogramBounds ?? [], {
        isEquality,
        isRange,
      });
    }
    if (dataType.includes('date') || dataType.includes('time')) {
      return isRange ? "'2023-01-15'" : "'2023-01-01'";
    }
    if (dataType === 'boolean') {
      return 'true';
    }
    return "'sample_value'";
  }

  /** A generic replacement when the specific column type is unknown. */
  getGenericReplacement(context: string): string {
    const lowered = context.toLowerCase();

    if (lowered.split(WHITESPACE_PATTERN).some((word) => ['date', 'timestamp', 'time'].includes(word))) {
      return "'2023-01-01'";
    }
    if (includesAny(lowered, ['id', 'key', 'code', 'num'])) {
      return '43';
    }
    if (lowered.includes('like')) {
      return "'%sample%'";
    }
    if (includesAny(lowered, ['amount', 'price', 'cost', 'fee'])) {
      return '99.99';
    }
    if (includesAny(lowered, ['=', '>', '<', '>=', '<='])) {
      return '44';
    }
    return "'sample_value'";
  }

  /** Extract columns from a SELECT query, keyed by table. */
  async extractColumns(query: string): Promise<Map<string, Set<string>>> {
    try {
      const { stmts } = await parseSql(query);
      const stmt = AstNode.from(stmts[0]?.stmt);
      if (!stmt?.is('SelectStmt')) {
        return new Map();
      }
      return this.extractStmtColumns(stmt);
    } catch {
      logWarning('Error extracting columns from query');
      return new Map();
    }
  }

  /** Extract columns from a parsed SelectStmt. */
  extractStmtColumns(stmt: AstNode): Map<string, Set<string>> {
    try {
      const collector = new ColumnCollector();
      collector.visit(stmt);
      return collector.columns;
    } catch {
      logWarning(`Error extracting columns from query: ${stmt.type}`);
      return new Map();
    }
  }
}
