import { vi } from 'vitest';

import type { SqlExecutor } from '../../src/sql/safe-sql.ts';
import type { ResultSet, Row } from '../../src/sql/sql-driver.ts';

/** Rows, a full result set (to express columns with zero rows), or `undefined` for a statement with no result set. */
export type FakeResult = Row[] | ResultSet | undefined;
export type RowHandler = (query: string, params?: readonly unknown[] | null) => FakeResult | Promise<FakeResult>;

function toResultSet(result: FakeResult): ResultSet {
  if (result === undefined) {
    return { columns: [], rows: [] };
  }
  if (Array.isArray(result)) {
    return { columns: Object.keys(result[0] ?? {}), rows: result };
  }
  return result;
}

/** An executor whose `executeResultSet` is a spy answering through `handler`. */
export function fakeExecutor(handler: RowHandler) {
  const executeResultSet = vi.fn(
    async (query: string, params?: readonly unknown[] | null, _forceReadonly?: boolean): Promise<ResultSet> =>
      toResultSet(await handler(query, params))
  );
  return { executeResultSet } satisfies SqlExecutor;
}
