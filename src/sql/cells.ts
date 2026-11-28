import type { Row } from './safe-sql.ts';

/**
 * Strict readers for one column of a result row. A reader only narrows the value pg's type parsers produced (see
 * `customTypes` in `sql-driver.ts`); it never converts between kinds. A missing column or a value of an unexpected
 * kind throws a CellError naming the column, so a misspelt column or an unexpected NULL fails loudly instead of
 * becoming "undefined", NaN or false.
 */

export class CellError extends Error {
  constructor(column: string, expected: string, actual: unknown) {
    super(`Column "${column}": expected ${expected}, got ${kindOf(actual)}`);
    this.name = 'CellError';
  }
}

function kindOf(cell: unknown): string {
  if (cell === null) {
    return 'NULL';
  }
  if (Array.isArray(cell)) {
    return 'array';
  }
  if (cell instanceof Date) {
    return 'date';
  }
  return typeof cell;
}

/** The raw value of a column that must be present; NULL is allowed. */
export function value(row: Row, column: string): unknown {
  if (!Object.hasOwn(row, column)) {
    throw new Error(`Column "${column}" is missing from the result`);
  }
  return row[column];
}

/** text, varchar, name and the information_schema string domains. */
export function text(row: Row, column: string): string {
  const cell = value(row, column);
  if (typeof cell !== 'string') {
    throw new CellError(column, 'text', cell);
  }
  return cell;
}

export function nullableText(row: Row, column: string): string | null {
  return value(row, column) === null ? null : text(row, column);
}

export function boolean(row: Row, column: string): boolean {
  const cell = value(row, column);
  if (typeof cell !== 'boolean') {
    throw new CellError(column, 'boolean', cell);
  }
  return cell;
}

/** int2, int4, oid, or an int8 that fits a safe integer. */
export function integer(row: Row, column: string): number {
  const cell = value(row, column);
  if (typeof cell !== 'number' || !Number.isSafeInteger(cell)) {
    throw new CellError(column, 'integer', cell);
  }
  return cell;
}

export function nullableInteger(row: Row, column: string): number | null {
  return value(row, column) === null ? null : integer(row, column);
}

/** An int8 as pg's parser gives it: a number when it is a safe integer, a bigint otherwise. */
export function int8(row: Row, column: string): number | bigint {
  const cell = value(row, column);
  if (typeof cell === 'bigint' || (typeof cell === 'number' && Number.isSafeInteger(cell))) {
    return cell;
  }
  throw new CellError(column, 'int8', cell);
}

export function nullableInt8(row: Row, column: string): number | bigint | null {
  return value(row, column) === null ? null : int8(row, column);
}

/** Any integer column as a bigint, for values that may exceed a safe integer. */
export function bigint(row: Row, column: string): bigint {
  const cell = int8(row, column);
  return typeof cell === 'bigint' ? cell : BigInt(cell);
}

const NUMERIC_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u;

/**
 * A finite number from a float column (a number) or a numeric column (pg leaves numeric as text, so its decimal
 * text is parsed). NaN and infinities are rejected.
 */
export function numeric(row: Row, column: string): number {
  const cell = value(row, column);
  const parsed = typeof cell === 'string' && NUMERIC_TEXT.test(cell) ? Number(cell) : cell;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    throw new CellError(column, 'a finite number', cell);
  }
  return parsed;
}

export function nullableNumeric(row: Row, column: string): number | null {
  return value(row, column) === null ? null : numeric(row, column);
}

/** timestamp, timestamptz or date, which pg parses to a Date. */
export function nullableDate(row: Row, column: string): Date | null {
  const cell = value(row, column);
  if (cell === null) {
    return null;
  }
  if (!(cell instanceof Date)) {
    throw new CellError(column, 'date', cell);
  }
  return cell;
}

/** A float or integer array (float4[], int4[], ...), which pg parses to an array of numbers. */
export function nullableNumberArray(row: Row, column: string): number[] | null {
  const cell = value(row, column);
  if (cell === null) {
    return null;
  }
  if (!Array.isArray(cell) || !cell.every((item): item is number => typeof item === 'number')) {
    throw new CellError(column, 'array of numbers', cell);
  }
  return cell;
}

/**
 * Text for a value pg produced, for writing it into SQL or output: JSON for objects and arrays (parsed json and
 * jsonb), ISO 8601 for dates, and the plain string form for anything else.
 */
export function cellText(cell: unknown): string {
  if (typeof cell === 'string') {
    return cell;
  }
  if (typeof cell === 'number' || typeof cell === 'bigint' || typeof cell === 'boolean') {
    return String(cell);
  }
  if (cell instanceof Date) {
    return cell.toISOString();
  }
  // JSON.stringify gives undefined for undefined, functions and symbols, none of which pg produces.
  const json: string | undefined = JSON.stringify(cell);
  if (json === undefined) {
    throw new TypeError(`Cannot write a value of type ${typeof cell} as text`);
  }
  return json;
}
