import pg from 'pg';
import { vi } from 'vitest';

import type { PoolLike, QueryResultLike } from '../../src/sql/sql-driver.ts';

export interface RecordedQuery {
  text: string;
  values: readonly unknown[] | undefined;
}

/** A handler may return a promise to keep a statement pending, for example until the client is cancelled. */
export type QueryHandler = (query: RecordedQuery) => QueryResultLike[] | Promise<QueryResultLike[]>;

export function rowsResult(rows: Record<string, unknown>[]): QueryResultLike {
  const first = rows[0] ?? { id: null };
  return { rows, fields: Object.keys(first).map((name) => ({ name })) };
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
  const hang = (): Promise<QueryResultLike[]> =>
    new Promise((_resolve, reject) => {
      pendingRejects.push(reject);
    });
  const pool: PoolLike = {
    connect: () =>
      Promise.resolve({
        query(text, values) {
          const recorded = { text, values };
          queries.push(recorded);
          try {
            return Promise.resolve(handler(recorded));
          } catch (error) {
            // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- passes on whatever the handler threw, Error or not
            return Promise.reject(error);
          }
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
