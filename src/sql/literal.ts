import pg from "pg";

/** Marker for a quoted SQL identifier, usable as a `{}` parameter. */
export class Identifier {
  readonly parts: readonly string[];

  constructor(parts: readonly string[]) {
    this.parts = parts;
  }

  toSql(): string {
    return this.parts.map((part) => pg.escapeIdentifier(part)).join(".");
  }
}

export function identifier(...parts: string[]): Identifier {
  return new Identifier(parts);
}

function arrayElement(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (Array.isArray(value)) {
    return `{${value.map(arrayElement).join(",")}}`;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "t" : "f";
  }
  const text = value instanceof Date ? value.toISOString() : String(value);
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function literal(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number" || typeof value === "bigint") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      return pg.escapeLiteral(String(value));
    }
    return String(value);
  }
  if (typeof value === "string") {
    return pg.escapeLiteral(value);
  }
  if (Array.isArray(value)) {
    return pg.escapeLiteral(arrayElement(value));
  }
  if (value instanceof Date) {
    return pg.escapeLiteral(value.toISOString());
  }
  throw new TypeError(`Cannot convert ${typeof value} to a SQL literal`);
}

const PLACEHOLDER_TOKEN = /[{][{]|[}][}]|[{][}]|[{}]/gu;

/** Replaces each `{}` with the quoted parameter; `{{` and `}}` are literal braces. */
export function paramSqlToQuery(
  query: string,
  params: readonly unknown[]
): string {
  let next = 0;
  // Surplus parameters are ignored, as Python's str.format does.
  return query.replaceAll(PLACEHOLDER_TOKEN, (token) => {
    if (token === "{{") {
      return "{";
    }
    if (token === "}}") {
      return "}";
    }
    if (token !== "{}") {
      throw new Error(`Single '${token}' encountered in format string`);
    }
    if (next >= params.length) {
      throw new Error(
        "Replacement index out of range for positional args tuple"
      );
    }
    const param = params[next];
    next += 1;
    return param instanceof Identifier ? param.toSql() : literal(param);
  });
}
