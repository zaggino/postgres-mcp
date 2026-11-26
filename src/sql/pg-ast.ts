import { loadModule, parseSync, SqlError } from "libpg-query";

export interface JsonObject {
  readonly [key: string]: unknown;
}

/** A statement as returned in `ParseResult.stmts` (the pglast `RawStmt`). */
export type RawStmtJson = JsonObject;

export interface ParseTree {
  readonly stmts: readonly RawStmtJson[];
}

/** A node serialised as `{ NodeType: { ...fields } }`. */
export interface WrappedNode {
  readonly fields: JsonObject;
  readonly type: string;
}

/** The SQL text is not valid PostgreSQL grammar. */
export class SqlParseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SqlParseError";
  }
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Node type names start with an uppercase letter (`SelectStmt`, `A_Const`);
// field names never do, which is what tells a wrapped node from a bare struct.
const NODE_TYPE_NAME = /^[A-Z]/u;

/** Returns the node when `value` is a `{ NodeType: {...} }` wrapper, else undefined. */
export function asWrappedNode(value: unknown): WrappedNode | undefined {
  if (!isJsonObject(value)) {
    return;
  }
  const keys = Object.keys(value);
  const [type] = keys;
  if (keys.length !== 1 || type === undefined || !NODE_TYPE_NAME.test(type)) {
    return;
  }
  const fields = value[type];
  return isJsonObject(fields) ? { type, fields } : undefined;
}

let loading: Promise<void> | undefined;

/** Loads the WASM module once; required before {@link parseSqlSync}. */
export function loadParser(): Promise<void> {
  loading ??= loadModule().catch((error: unknown) => {
    loading = undefined;
    throw error;
  });
  return loading;
}

function toParseTree(result: unknown): ParseTree {
  if (!isJsonObject(result)) {
    throw new Error("Unexpected parser output");
  }
  const { stmts } = result;
  if (stmts === undefined) {
    return { stmts: [] };
  }
  if (!Array.isArray(stmts)) {
    throw new Error("Unexpected parser output");
  }
  const checked: RawStmtJson[] = [];
  for (const stmt of stmts) {
    if (!isJsonObject(stmt)) {
      throw new Error("Unexpected parser output");
    }
    checked.push(stmt);
  }
  return { stmts: checked };
}

/** Synchronous parse; the module must already be loaded via {@link loadParser}. */
export function parseSqlSync(sql: string): ParseTree {
  // The parser rejects an empty string; an empty script has no statements.
  if (sql === "") {
    return { stmts: [] };
  }
  try {
    return toParseTree(parseSync(sql));
  } catch (error) {
    if (error instanceof SqlError) {
      throw new SqlParseError(error.message, { cause: error });
    }
    throw error;
  }
}

export async function parseSql(sql: string): Promise<ParseTree> {
  await loadParser();
  return parseSqlSync(sql);
}
