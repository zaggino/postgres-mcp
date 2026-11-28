import { vi } from 'vitest';

import type { ResultSet, Row, SqlExecutor } from '../../src/sql/safe-sql.ts';

/** Answers a query with rows; return `undefined` for a statement with no result set. */
export type RowHandler = (
  query: string,
  params?: readonly unknown[] | null
) => Row[] | undefined | Promise<Row[] | undefined>;

/** An executor whose `executeQuery` and `executeResultSet` are spies answering through `handler`. */
export function fakeExecutor(handler: RowHandler) {
  const executeResultSet = vi.fn(
    async (query: string, params?: readonly unknown[] | null, _forceReadonly?: boolean): Promise<ResultSet> => {
      const rows = await handler(query, params);
      return { columns: rows ? Object.keys(rows[0] ?? {}) : [], rows: rows ?? [] };
    }
  );
  const executeQuery = vi.fn(
    async (query: string, params?: readonly unknown[] | null, _forceReadonly?: boolean): Promise<Row[]> =>
      (await handler(query, params)) ?? []
  );
  return { executeQuery, executeResultSet } satisfies SqlExecutor;
}
