import { vi } from 'vitest';

import type { SqlExecutor } from '../../src/sql/safe-sql.ts';
import type { ResultSet, Row, Table } from '../../src/sql/sql-driver.ts';

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

/** An executor whose `executeResultSet` and `executeTable` are spies answering through `handler`. */
export function fakeExecutor(handler: RowHandler) {
  const executeResultSet = vi.fn(
    async (query: string, params?: readonly unknown[] | null, _forceReadonly?: boolean): Promise<ResultSet> =>
      toResultSet(await handler(query, params))
  );
  const executeTable = vi.fn(async (query: string, _forceReadonly?: boolean): Promise<Table> => {
    const { columns, rows } = toResultSet(await handler(query, null));
    return {
      columns: columns.map((name) => ({ name, typeOid: 0 })),
      rows: rows.map((row) => columns.map((name) => row[name])),
    };
  });
  return { executeResultSet, executeTable } satisfies SqlExecutor;
}
