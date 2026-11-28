import pg from 'pg';
import { vi } from 'vitest';

import type { ArrayResultLike, PoolLike, QueryResultLike } from '../../src/sql/sql-driver.ts';

export interface RecordedQuery {
  text: string;
  values: readonly unknown[] | undefined;
}

type HandlerResult = QueryResultLike | ArrayResultLike;

/** A handler may return a promise to keep a statement pending, for example until the client is cancelled. */
export type QueryHandler = (query: RecordedQuery) => HandlerResult[] | Promise<HandlerResult[]>;

export function rowsResult(rows: Record<string, unknown>[]): QueryResultLike {
  const first = rows[0] ?? { id: null };
  return { rows, fields: Object.keys(first).map((name) => ({ name })) };
}

/** A result with array rows, which can express duplicate column names; only `queryArrays` accepts it. */
export function arrayRowsResult(names: string[], rows: unknown[][], typeOids: number[] = []): ArrayResultLike {
  return { rows, fields: names.map((name, index) => ({ name, dataTypeID: typeOids[index] ?? 0 })) };
}

function isArrayResult(result: QueryResultLike | ArrayResultLike): result is ArrayResultLike {
  return result.rows.some((row) => Array.isArray(row)) || result.fields.some((field) => 'dataTypeID' in field);
}

function toArrayResult(result: QueryResultLike | ArrayResultLike): ArrayResultLike {
  if (isArrayResult(result)) {
    return result;
  }
  const names = result.fields.map((field) => field.name);
  return {
    fields: result.fields.map((field) => ({ name: field.name, dataTypeID: 0 })),
    rows: result.rows.map((row) => names.map((name) => row[name])),
  };
}

export const noRowsResult: QueryResultLike = { rows: [], fields: [] };

/** A pg.DatabaseError as Postgres reports it, for example 57014 for a cancelled or timed-out statement. */
export function databaseError(message: string, code: string): pg.DatabaseError {
  const error = new pg.DatabaseError(message, 0, 'error');
  error.code = code;
  return error;
}

/**
 * A pool that records every statement sent through its clients. `cancel` is a spy; while a statement from `hang`
 * is pending, calling `cancel` rejects it with Postgres's "canceling statement due to user request" (57014).
 */
export function createFakePool(handler: QueryHandler = () => [noRowsResult]) {
  const queries: RecordedQuery[] = [];
  const releases: (boolean | undefined)[] = [];
  const end = vi.fn(() => Promise.resolve());
  const pendingRejects: ((error: Error) => void)[] = [];
  const cancel = vi.fn(() => {
    for (const reject of pendingRejects.splice(0)) {
      reject(databaseError('canceling statement due to user request', '57014'));
    }
    return Promise.resolve();
  });
  /** Resolves a handler result that never settles until `cancel` is called. */
  const hang = (): Promise<HandlerResult[]> =>
    new Promise((_resolve, reject) => {
      pendingRejects.push(reject);
    });
  const run = async (recorded: RecordedQuery): Promise<HandlerResult[]> => {
    queries.push(recorded);
    return await handler(recorded);
  };
  const pool: PoolLike = {
    connect: () =>
      Promise.resolve({
        async query(text, values) {
          const results = await run({ text, values });
          return results.map((result) => {
            if (isArrayResult(result)) {
              throw new Error('The handler returned an array-rows result for a query that wants row objects');
            }
            return result;
          });
        },
        async queryArrays(text) {
          return (await run({ text, values: undefined })).map(toArrayResult);
        },
        release(destroy) {
          releases.push(destroy);
        },
        cancel,
      }),
    end,
  };
  return { pool, queries, releases, end, cancel, hang };
}
