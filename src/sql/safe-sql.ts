import {
  ALLOWED_EXTENSIONS,
  ALLOWED_FUNCTIONS,
  ALLOWED_NODE_TYPES,
  ALLOWED_STMT_TYPES,
  STRUCT_FIELD_TYPES,
} from './allowlists.ts';
import type { Identifier } from './literal.ts';
import { paramSqlToQuery } from './literal.ts';
import type { JsonObject, RawStmtJson } from './pg-ast.ts';
import { asWrappedNode, isJsonObject, parseSql, SqlParseError } from './pg-ast.ts';
import type { DbConnPool, RowResult } from './sql-driver.ts';

const PG_CATALOG_PATTERN = /^pg_catalog\.(?<name>.+)$/u;
const STMT_NOT_ALLOWED =
  'Only SELECT, ANALYZE, VACUUM, EXPLAIN, SHOW and other read-only statements are allowed. Received';
const SQL_COMMENT_PREFIX = '/* postgres-mcp */';

/** What SafeSqlDriver wraps; a SqlDriver satisfies it. */
export interface SqlExecutor {
  /** The connection pool behind the executor, when it has one; keys per-connection caches. */
  readonly pool?: DbConnPool;
  executeQuery: (
    query: string,
    params?: readonly unknown[] | null,
    forceReadonly?: boolean
  ) => Promise<RowResult[] | null>;
}

function logWarning(message: string): void {
  process.stderr.write(`${message}\n`);
}

function logError(message: string): void {
  process.stderr.write(`${message}\n`);
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
    throw new Error(`Error validating query: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

/** Wraps an executor so only read-only, allowlisted SQL reaches the database. */
export class SafeSqlDriver implements SqlExecutor {
  readonly sqlDriver: SqlExecutor;
  readonly timeout: number | null;

  get pool(): DbConnPool | undefined {
    return this.sqlDriver.pool;
  }

  /** `timeout` is in seconds; a falsy value disables it. */
  constructor(sqlDriver: SqlExecutor, timeout: number | null = null) {
    this.sqlDriver = sqlDriver;
    this.timeout = timeout;
  }

  // The third argument is accepted for interface compatibility but ignored:
  // restricted mode always runs read-only.
  async executeQuery(
    query: string,
    params: readonly unknown[] | null = null,
    _forceReadonly = true
  ): Promise<RowResult[] | null> {
    await validateQuery(query);
    const run = () => this.sqlDriver.executeQuery(`${SQL_COMMENT_PREFIX} ${query}`, params, true);

    if (!this.timeout) {
      return await run();
    }
    return await this.runWithTimeout(run);
  }

  private async runWithTimeout(run: () => Promise<RowResult[] | null>): Promise<RowResult[] | null> {
    const seconds = this.timeout;
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => {
          timedOut = true;
          logWarning(`Query execution timed out after ${seconds} seconds`);
          reject(
            new Error(
              `Query execution timed out after ${seconds} seconds in restricted mode. Consider simplifying your query or increasing the timeout.`
            )
          );
        },
        (seconds ?? 0) * 1000
      );
    });
    try {
      return await Promise.race([run(), expired]);
    } catch (error) {
      if (!timedOut) {
        logError(`Error executing query: ${String(error)}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  static sqlToQuery(sql: string | Identifier): string {
    return typeof sql === 'string' ? sql : sql.toSql();
  }

  static paramSqlToQuery(query: string, params: readonly unknown[]): string {
    return SafeSqlDriver.sqlToQuery(paramSqlToQuery(query, params));
  }

  static executeParamQuery(
    sqlDriver: SqlExecutor,
    query: string,
    params?: readonly unknown[] | null
  ): Promise<RowResult[] | null> {
    if (params && params.length > 0) {
      return sqlDriver.executeQuery(SafeSqlDriver.paramSqlToQuery(query, params));
    }
    return sqlDriver.executeQuery(query);
  }
}
