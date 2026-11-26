// biome-ignore lint/style/noExcessiveClassesPerFile: Visitor and AstNode are specified to live beside SqlParseError in pg-ast.ts
import { loadModule, parseSync, SqlError } from "libpg-query";
import { STRUCT_FIELD_TYPES } from "./allowlists.ts";

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

function collectNodes(
  value: unknown,
  structType: string | undefined,
  out: AstNode[]
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectNodes(item, undefined, out);
    }
    return;
  }
  const wrapped = AstNode.from(value);
  if (wrapped) {
    out.push(wrapped);
  } else if (isJsonObject(value) && structType !== undefined) {
    out.push(new AstNode(structType, value));
  }
}

/**
 * A parse-tree node: a `{ NodeType: {...} }` wrapper, or a bare struct whose
 * type is known from its owning field (STRUCT_FIELD_TYPES), as pglast exposes
 * both. Accessors return `undefined` for omitted (false/empty/zero) fields.
 */
export class AstNode {
  readonly fields: JsonObject;
  readonly type: string;

  constructor(type: string, fields: JsonObject) {
    this.type = type;
    this.fields = fields;
  }

  static from(value: unknown): AstNode | undefined {
    const wrapped = asWrappedNode(value);
    return wrapped ? new AstNode(wrapped.type, wrapped.fields) : undefined;
  }

  is(type: string): boolean {
    return this.type === type;
  }

  string(name: string): string | undefined {
    const value = this.fields[name];
    return typeof value === "string" ? value : undefined;
  }

  number(name: string): number | undefined {
    const value = this.fields[name];
    return typeof value === "number" ? value : undefined;
  }

  /** A single child node (wrapped, or a bare struct of a known type). */
  node(name: string): AstNode | undefined {
    const out: AstNode[] = [];
    const value = this.fields[name];
    if (!Array.isArray(value)) {
      collectNodes(value, STRUCT_FIELD_TYPES.get(this.type)?.get(name), out);
    }
    return out[0];
  }

  /** The nodes of a list field; empty when the field is absent. */
  nodes(name: string): AstNode[] {
    const out: AstNode[] = [];
    const value = this.fields[name];
    if (Array.isArray(value)) {
      collectNodes(value, undefined, out);
    }
    return out;
  }

  /** A field that is either one node or a list of nodes (e.g. `A_Expr.rexpr`); empty list is undefined. */
  operand(name: string): AstNode | AstNode[] | undefined {
    if (Array.isArray(this.fields[name])) {
      const list = this.nodes(name);
      return list.length > 0 ? list : undefined;
    }
    return this.node(name);
  }

  /** Child nodes in field (slot) order, lists flattened. */
  children(): AstNode[] {
    const out: AstNode[] = [];
    const structTypes = STRUCT_FIELD_TYPES.get(this.type);
    for (const [name, value] of Object.entries(this.fields)) {
      collectNodes(value, structTypes?.get(name), out);
    }
    return out;
  }
}

export type VisitRoot = AstNode | readonly AstNode[] | undefined;

/**
 * Mimics `pglast.visitors.Visitor`. Calling `visit` walks the tree
 * breadth-first from the root(s) (a FIFO queue; children are enqueued in field
 * order after a node's visit method returns). A node of type `T` is dispatched
 * to `visit<T>(ancestors, node)` with underscores removed from `T`
 * (`RangeVar` -> `visitRangeVar`, `A_Expr` -> `visitAExpr`) when the subclass
 * defines it. Visit methods return nothing, so descent always continues, and
 * may call `visit` again on a child; each call has its own queue, so nodes
 * reached that way are visited again by the outer walk (as in pglast).
 */
export class Visitor {
  visit(root: VisitRoot): void {
    const roots = root instanceof AstNode ? [root] : (root ?? []);
    const queue = roots.map((node) => ({
      node,
      ancestors: [] as readonly AstNode[],
    }));
    // for-of over an array also visits elements appended during iteration.
    for (const { node, ancestors } of queue) {
      const method: unknown = Reflect.get(
        this,
        `visit${node.type.replaceAll("_", "")}`
      );
      if (typeof method === "function") {
        Reflect.apply(method, this, [ancestors, node]);
      }
      const childAncestors = [...ancestors, node];
      for (const child of node.children()) {
        queue.push({ node: child, ancestors: childAncestors });
      }
    }
  }
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
