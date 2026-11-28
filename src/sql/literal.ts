import pg from 'pg';

/** Marker for a quoted SQL identifier, usable as a `{}` parameter. */
export class Identifier {
  readonly parts: readonly string[];

  constructor(parts: readonly string[]) {
    this.parts = parts;
  }

  toSql(): string {
    return this.parts.map((part) => pg.escapeIdentifier(part)).join('.');
  }
}

export function identifier(...parts: string[]): Identifier {
  return new Identifier(parts);
}

/**
 * Text for a value pg produced, for writing it into SQL: JSON for objects and arrays (parsed json and jsonb), and the
 * plain string form for anything else.
 */
function cellText(cell: unknown): string {
  if (typeof cell === 'string') {
    return cell;
  }
  if (typeof cell === 'number' || typeof cell === 'bigint' || typeof cell === 'boolean') {
    return String(cell);
  }
  // JSON.stringify gives undefined for undefined, functions and symbols, none of which pg produces.
  const json: string | undefined = JSON.stringify(cell);
  if (json === undefined) {
    throw new TypeError(`Cannot write a value of type ${typeof cell} as text`);
  }
  return json;
}

function arrayElement(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (Array.isArray(value)) {
    return `{${value.map(arrayElement).join(',')}}`;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'boolean') {
    return value ? 't' : 'f';
  }
  const text = cellText(value);
  return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function literal(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      return pg.escapeLiteral(String(value));
    }
    // A leading space keeps `x -{}` from turning into a `--` comment.
    return value < 0 ? ` ${String(value)}` : String(value);
  }
  if (typeof value === 'string') {
    return pg.escapeLiteral(value);
  }
  if (Array.isArray(value)) {
    return pg.escapeLiteral(arrayElement(value));
  }
  throw new TypeError(`Cannot convert ${typeof value} to a SQL literal`);
}

const PLACEHOLDER_TOKEN = /[{][{]|[}][}]|[{][}]|[{}]/gu;

/** Replaces each `{}` with the quoted parameter; `{{` and `}}` are literal braces. */
export function paramSqlToQuery(query: string, params: readonly unknown[]): string {
  let next = 0;
  // Surplus parameters are ignored.
  return query.replaceAll(PLACEHOLDER_TOKEN, (token) => {
    if (token === '{{') {
      return '{';
    }
    if (token === '}}') {
      return '}';
    }
    if (token !== '{}') {
      throw new Error(`Single '${token}' encountered in format string`);
    }
    if (next >= params.length) {
      throw new Error('Replacement index out of range for positional args tuple');
    }
    const param = params[next];
    next += 1;
    return param instanceof Identifier ? param.toSql() : literal(param);
  });
}
