import { errorMessage } from '../errors.ts';
import type { JsonObject } from '../json.ts';
import { isJsonObject } from '../json.ts';
import {
  ALLOWED_EXTENSIONS,
  ALLOWED_FUNCTIONS,
  ALLOWED_NODE_TYPES,
  ALLOWED_STMT_TYPES,
  STRUCT_FIELD_TYPES,
} from './allowlists.ts';
import type { Identifier } from './literal.ts';
import { paramSqlToQuery } from './literal.ts';
import type { RawStmtJson } from './pg-ast.ts';
import { asWrappedNode, parseSql, SqlParseError } from './pg-ast.ts';
import type { DbConnPool } from './sql-driver.ts';
import { QueryTimeoutError } from './sql-driver.ts';

const PG_CATALOG_PATTERN = /^pg_catalog\.(?<name>.+)$/u;
const STMT_NOT_ALLOWED =
  'Only SELECT, ANALYZE, VACUUM, EXPLAIN, SHOW and other read-only statements are allowed. Received';
const SQL_COMMENT_PREFIX = '/* postgres-mcp */';

/** The timeout error as upstream words it in restricted mode. */
export class RestrictedQueryTimeoutError extends QueryTimeoutError {
  constructor(seconds: number, options?: { cause?: unknown }) {
    super(seconds, options);
    this.message = `Query execution timed out after ${seconds} seconds in restricted mode. Consider simplifying your query or increasing the timeout.`;
    this.name = 'RestrictedQueryTimeoutError';
  }
}

/** One result row, keyed by column name, with values as pg's type parsers produce them. */
export type Row = Record<string, unknown>;

/** The last statement's result: column names, then rows. No columns means the statement returned no result set. */
export interface ResultSet {
  columns: readonly string[];
  rows: Row[];
}

/** What SafeSqlDriver wraps; a SqlDriver satisfies it. */
export interface SqlExecutor {
  /** The connection pool behind the executor, when it has one; keys per-connection caches. */
  readonly pool?: DbConnPool;
  /** Rows of the last statement's result; empty when it returned no rows or no result set. */
  executeQuery: (query: string, params?: readonly unknown[] | null, forceReadonly?: boolean) => Promise<Row[]>;
  /** The last statement's columns and rows; only execute_sql needs to tell "no result set" from "no rows". */
  executeResultSet: (query: string, params?: readonly unknown[] | null, forceReadonly?: boolean) => Promise<ResultSet>;
}

function functionName(funcname: unknown): string {
  if (!Array.isArray(funcname)) {
    return '';
  }
  return funcname
    .map((part) => {
      const node = asWrappedNode(part);
      if (node?.type !== 'String') {
        throw new Error('Function name part is not a string');
      }
      return typeof node.fields.sval === 'string' ? node.fields.sval : '';
    })
    .join('.')
    .toLowerCase();
}

function isStringConstant(value: unknown): boolean {
  const node = asWrappedNode(value);
  return node?.type === 'A_Const' && isJsonObject(node.fields.sval);
}

function checkLikePattern(fields: JsonObject): void {
  if ((fields.kind === 'AEXPR_LIKE' || fields.kind === 'AEXPR_ILIKE') && !isStringConstant(fields.rexpr)) {
    throw new Error('LIKE pattern must be a constant string');
  }
}

function checkFunctionCall(fields: JsonObject): void {
  const name = functionName(fields.funcname);
  const unqualified = PG_CATALOG_PATTERN.exec(name)?.groups?.name ?? name;
  if (!ALLOWED_FUNCTIONS.has(unqualified)) {
    throw new Error(`Function ${name} is not allowed`);
  }
}

function checkExplain(fields: JsonObject): void {
  const options = Array.isArray(fields.options) ? fields.options : [];
  for (const option of options) {
    const node = asWrappedNode(option);
    if (node?.type === 'DefElem' && node.fields.defname === 'analyze') {
      throw new Error('EXPLAIN ANALYZE is not supported');
    }
  }
}

function checkNodeRules(type: string, fields: JsonObject): void {
  switch (type) {
    case 'A_Expr': {
      checkLikePattern(fields);
      break;
    }
    case 'FuncCall': {
      checkFunctionCall(fields);
      break;
    }
    case 'SelectStmt': {
      if (Array.isArray(fields.lockingClause) && fields.lockingClause.length) {
        throw new Error('Locking clause on select is prohibited');
      }
      break;
    }
    case 'ExplainStmt': {
      checkExplain(fields);
      break;
    }
    case 'CreateExtensionStmt': {
      if (typeof fields.extname !== 'string' || !ALLOWED_EXTENSIONS.has(fields.extname)) {
        throw new Error(`CREATE EXTENSION ${String(fields.extname)} is not supported`);
      }
      break;
    }
    default: {
      break;
    }
  }
}

function validateNode(type: string, fields: JsonObject): void {
  // pglast models a List as a plain tuple, so it is traversed, not allowlisted.
  if (type !== 'List') {
    if (!ALLOWED_NODE_TYPES.has(type)) {
      throw new Error(`Node type ${type} is not allowed`);
    }
    checkNodeRules(type, fields);
  }
  const structFields = STRUCT_FIELD_TYPES.get(type);
  for (const [name, value] of Object.entries(fields)) {
    validateValue(value, structFields?.get(name));
  }
}

/**
 * Validates a field value at any depth. A value is a scalar, an array, a
 * wrapped node (`{ NodeType: {...} }`), an empty object (a NULL list item), or
 * a bare struct whose node type is only known from the owning field
 * (STRUCT_FIELD_TYPES). Anything else is rejected, never skipped.
 */
function validateValue(value: unknown, structType?: string): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      validateValue(item);
    }
    return;
  }
  if (!isJsonObject(value)) {
    return;
  }
  const node = asWrappedNode(value);
  if (node) {
    validateNode(node.type, node.fields);
  } else if (structType !== undefined) {
    validateNode(structType, value);
  } else if (Object.keys(value).length > 0) {
    throw new Error('Unrecognised structure in parse tree');
  }
}

function validateStatement(raw: RawStmtJson): void {
  const inner = asWrappedNode(raw.stmt);
  if (!(inner && ALLOWED_STMT_TYPES.has(inner.type))) {
    throw new Error(`${STMT_NOT_ALLOWED} statement type: ${inner?.type ?? 'unknown'}`);
  }
  validateNode('RawStmt', raw);
}

async function validateQuery(query: string): Promise<void> {
  let stmts: readonly RawStmtJson[];
  try {
    ({ stmts } = await parseSql(query));
  } catch (error) {
    if (error instanceof SqlParseError) {
      throw new Error('Failed to parse SQL statement', { cause: error });
    }
    throw error;
  }
  try {
    for (const stmt of stmts) {
      validateStatement(stmt);
    }
  } catch (error) {
    throw new Error(`Error validating query: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

/** Wraps an executor so only read-only, allowlisted SQL reaches the database. */
export class SafeSqlDriver implements SqlExecutor {
  readonly sqlDriver: SqlExecutor;

  get pool(): DbConnPool | undefined {
    return this.sqlDriver.pool;
  }

  constructor(sqlDriver: SqlExecutor) {
    this.sqlDriver = sqlDriver;
  }

  // The third argument is accepted for interface compatibility but ignored:
  // restricted mode always runs read-only.
  async executeResultSet(
    query: string,
    params: readonly unknown[] | null = null,
    _forceReadonly = true
  ): Promise<ResultSet> {
    await validateQuery(query);
    try {
      return await this.sqlDriver.executeResultSet(`${SQL_COMMENT_PREFIX} ${query}`, params, true);
    } catch (error) {
      if (error instanceof QueryTimeoutError) {
        throw new RestrictedQueryTimeoutError(error.seconds, { cause: error.cause });
      }
      throw error;
    }
  }

  async executeQuery(query: string, params: readonly unknown[] | null = null, _forceReadonly = true): Promise<Row[]> {
    return (await this.executeResultSet(query, params)).rows;
  }

  static sqlToQuery(sql: string | Identifier): string {
    return typeof sql === 'string' ? sql : sql.toSql();
  }

  static paramSqlToQuery(query: string, params: readonly unknown[]): string {
    return SafeSqlDriver.sqlToQuery(paramSqlToQuery(query, params));
  }

  static executeParamQuery(sqlDriver: SqlExecutor, query: string, params?: readonly unknown[] | null): Promise<Row[]> {
    if (params && params.length > 0) {
      return sqlDriver.executeQuery(SafeSqlDriver.paramSqlToQuery(query, params));
    }
    return sqlDriver.executeQuery(query);
  }
}
