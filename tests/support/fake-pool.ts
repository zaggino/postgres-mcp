import { vi } from "vitest";
import type { PoolLike, QueryResultLike } from "../../src/sql/sql-driver.ts";

export interface RecordedQuery {
  text: string;
  values: readonly unknown[] | undefined;
}

export type QueryHandler = (query: RecordedQuery) => QueryResultLike[];

export function rowsResult(rows: Record<string, unknown>[]): QueryResultLike {
  const first = rows[0] ?? { id: null };
  return { rows, fields: Object.keys(first).map((name) => ({ name })) };
}

export const noRowsResult: QueryResultLike = { rows: [], fields: [] };

/** A pool that records every statement sent through its clients. */
export function createFakePool(handler: QueryHandler = () => [noRowsResult]) {
  const queries: RecordedQuery[] = [];
  const releases: (boolean | undefined)[] = [];
  const end = vi.fn(() => Promise.resolve());
  const pool: PoolLike = {
    connect: () =>
      Promise.resolve({
        query(text, values) {
          const recorded = { text, values };
          queries.push(recorded);
          try {
            return Promise.resolve(handler(recorded));
          } catch (error) {
            return Promise.reject(error);
          }
        },
        release(destroy) {
          releases.push(destroy);
        },
      }),
    end,
  };
  return { pool, queries, releases, end };
}
