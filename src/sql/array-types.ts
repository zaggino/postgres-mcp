import pg from 'pg';

import { errorMessage } from '../errors.ts';
import { log } from '../log.ts';
import * as cell from './cells.ts';
import type { SqlExecutor } from './safe-sql.ts';
import { SafeSqlDriver } from './safe-sql.ts';
import type { DbConnPool, Table } from './sql-driver.ts';
import { customTypes, parseArrayLiteral } from './type-parsers.ts';

interface ArrayType {
  delimiter: string;
  elementOid: number;
}

/**
 * Per type OID of a column: the array's element type and delimiter, or null for a type that is not an array. A domain
 * over an array type counts as that array (one level of domain). The delimiter is the element type's `typdelim`, where
 * Postgres keeps it (`box` uses `;`).
 */
const LOOKUP_SQL = `SELECT t.oid AS oid,
  CASE WHEN a.typcategory = 'A' AND a.typelem <> 0 THEN a.typelem END AS element_oid,
  e.typdelim AS delimiter
FROM pg_catalog.pg_type t
JOIN pg_catalog.pg_type a ON a.oid = CASE WHEN t.typtype = 'd' THEN t.typbasetype ELSE t.oid END
LEFT JOIN pg_catalog.pg_type e ON e.oid = a.typelem AND a.typcategory = 'A'
WHERE t.oid = ANY({})`;

/** Scalar built-in types: never arrays, so a text cell of one needs no lookup. */
const SCALAR_OIDS = new Set<number>(Object.values(pg.types.builtins));

// Array-ness per type OID per connection pool; an executor without a pool is its own key.
const caches = new WeakMap<DbConnPool | SqlExecutor, Map<number, ArrayType | null>>();

function cacheFor(executor: SqlExecutor): Map<number, ArrayType | null> {
  const key = executor.pool ?? executor;
  let cache = caches.get(key);
  if (!cache) {
    cache = new Map();
    caches.set(key, cache);
  }
  return cache;
}

async function lookUp(executor: SqlExecutor, oids: readonly number[], cache: Map<number, ArrayType | null>) {
  const rows = await SafeSqlDriver.executeParamQuery(executor, LOOKUP_SQL, [oids]);
  const found = new Map<number, ArrayType | null>();
  for (const row of rows) {
    const elementOid = cell.nullableInteger(row, 'element_oid');
    const delimiter = cell.nullableText(row, 'delimiter');
    found.set(cell.integer(row, 'oid'), elementOid === null || delimiter === null ? null : { elementOid, delimiter });
  }
  for (const oid of oids) {
    cache.set(oid, found.get(oid) ?? null);
  }
}

/**
 * Replaces the text cells of array columns that pg has no parser for (enum, composite, domain, box, lseg, ... arrays)
 * with the parsed array. Cells pg already parsed, and NULLs, stay as they are. A failed lookup leaves the text.
 */
export async function decodeArrayColumns(executor: SqlExecutor, table: Table): Promise<Table> {
  const textOids = new Set<number>();
  for (const [index, column] of table.columns.entries()) {
    if (!SCALAR_OIDS.has(column.typeOid) && table.rows.some((row) => typeof row[index] === 'string')) {
      textOids.add(column.typeOid);
    }
  }
  if (textOids.size === 0) {
    return table;
  }

  const cache = cacheFor(executor);
  const unknown = [...textOids].filter((oid) => !cache.has(oid));
  if (unknown.length > 0) {
    try {
      await lookUp(executor, unknown, cache);
    } catch (error) {
      log('WARNING', `Could not look up array types for execute_sql: ${errorMessage(error)}`);
      return table;
    }
  }

  const arrays = table.columns.map((column) => cache.get(column.typeOid) ?? null);
  if (arrays.every((array) => array === null)) {
    return table;
  }
  return {
    columns: table.columns,
    rows: table.rows.map((row) =>
      row.map((value, index) => {
        const array = arrays[index];
        if (!array || typeof value !== 'string') {
          return value;
        }
        const parser = customTypes.getTypeParser(array.elementOid, 'text');
        // @types/pg types a parser as taking a number; at runtime it takes the column's text.
        const convert = (text: string): unknown => Reflect.apply(parser, undefined, [text]);
        try {
          return parseArrayLiteral(value, array.delimiter, convert);
        } catch {
          return value;
        }
      })
    ),
  };
}
