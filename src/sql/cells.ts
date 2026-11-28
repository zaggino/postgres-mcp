import type { Row } from './sql-driver.ts';

/**
 * Strict readers for one column of a result row. A reader narrows the value pg's type parsers produced (see
 * `customTypes` in `sql-driver.ts`) and throws a CellError naming the column on a missing column or a value of an
 * unexpected kind, so a misspelt column or an unexpected NULL fails loudly instead of becoming "undefined", NaN or
 * false. The only conversions are `numeric`, which parses decimal text because pg leaves numeric as text, and
 * `bigint`, which widens a number. `single` also throws a CellError, for a wrong row count, so every failure in this
 * module is one.
 */

export class CellError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CellError';
  }

  static missing(column: string): CellError {
    return new CellError(`Column "${column}" is missing from the result`);
  }

  static unexpected(column: string, expected: string, actual: unknown): CellError {
    return new CellError(`Column "${column}": expected ${expected}, got ${kindOf(actual)}`);
  }

  static rowCount(count: number): CellError {
    return new CellError(`Expected exactly one row, got ${count}`);
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

type Reader<T> = (row: Row, column: string) => T;

/** The raw value of a column that must be present; NULL is allowed. */
export function value(row: Row, column: string): unknown {
  if (!Object.hasOwn(row, column)) {
    throw CellError.missing(column);
  }
  return row[column];
}

/** The reader for a column that may be NULL. */
function nullable<T>(read: Reader<T>): Reader<T | null> {
  return (row, column) => (value(row, column) === null ? null : read(row, column));
}

/** The only row of a result that always has exactly one, such as an aggregate or SHOW. */
export function single(rows: readonly Row[]): Row {
  const [row] = rows;
  if (rows.length !== 1 || row === undefined) {
    throw CellError.rowCount(rows.length);
  }
  return row;
}

/** text, varchar, name and the information_schema string domains. */
export function text(row: Row, column: string): string {
  const cell = value(row, column);
  if (typeof cell !== 'string') {
    throw CellError.unexpected(column, 'text', cell);
  }
  return cell;
}

export const nullableText = nullable(text);

export function boolean(row: Row, column: string): boolean {
  const cell = value(row, column);
  if (typeof cell !== 'boolean') {
    throw CellError.unexpected(column, 'boolean', cell);
  }
  return cell;
}

/** int2, int4, oid, or an int8 that fits a safe integer. */
export function integer(row: Row, column: string): number {
  const cell = value(row, column);
  if (typeof cell !== 'number' || !Number.isSafeInteger(cell)) {
    throw CellError.unexpected(column, 'integer', cell);
  }
  return cell;
}

export const nullableInteger = nullable(integer);

/** An int8 as pg's parser gives it: a number when it is a safe integer, a bigint otherwise. */
export function int8(row: Row, column: string): number | bigint {
  const cell = value(row, column);
  if (typeof cell === 'bigint' || (typeof cell === 'number' && Number.isSafeInteger(cell))) {
    return cell;
  }
  throw CellError.unexpected(column, 'int8', cell);
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
    throw CellError.unexpected(column, 'a finite number', cell);
  }
  return parsed;
}

export const nullableNumeric = nullable(numeric);

/** timestamp, timestamptz or date, which pg parses to a Date. */
export function date(row: Row, column: string): Date {
  const cell = value(row, column);
  if (!(cell instanceof Date)) {
    throw CellError.unexpected(column, 'date', cell);
  }
  return cell;
}

export const nullableDate = nullable(date);

/** A float or integer array (float4[], int4[], ...), which pg parses to an array of numbers. */
export function numberArray(row: Row, column: string): number[] {
  const cell = value(row, column);
  if (!Array.isArray(cell) || !cell.every((item): item is number => typeof item === 'number')) {
    throw CellError.unexpected(column, 'array of numbers', cell);
  }
  return cell;
}

export const nullableNumberArray = nullable(numberArray);
