import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExtensionStatus } from '../../../src/sql/extension-utils.ts';
import type { SqlExecutor } from '../../../src/sql/safe-sql.ts';
import type { Row } from '../../../src/sql/sql-driver.ts';
import { TopQueriesCalc } from '../../../src/top-queries/top-queries-calc.ts';
import { fakeExecutor } from '../../support/fake-executor.ts';

const extensionUtils = vi.hoisted(() => ({
  checkExtension: vi.fn(),
  getPostgresVersion: vi.fn(),
}));

vi.mock('../../../src/sql/extension-utils.ts', () => extensionUtils);

type ExecuteResultSet = SqlExecutor['executeResultSet'];

function row(cells: Row): Row {
  return cells;
}

function extensionStatus(isInstalled: boolean): ExtensionStatus {
  return {
    isInstalled,
    isAvailable: true,
    name: 'pg_stat_statements',
    message: isInstalled ? 'Extension is installed' : 'Extension not installed',
    defaultVersion: isInstalled ? '1.0' : null,
  };
}

/** A driver that simulates the given PostgreSQL major version. */
function createDriver(pgVersion: number): {
  driver: SqlExecutor;
  executeResultSet: ReturnType<typeof vi.fn<ExecuteResultSet>>;
} {
  extensionUtils.getPostgresVersion.mockResolvedValue(pgVersion);
  const [total, mean] = pgVersion >= 13 ? ['total_exec_time', 'mean_exec_time'] : ['total_time', 'mean_time'];
  const driver = fakeExecutor((query) =>
    query.includes('pg_stat_statements')
      ? [
          row({
            query: 'SELECT * FROM users',
            calls: 100,
            [total]: 1000,
            [mean]: 10,
            rows: 1000,
          }),
          row({
            query: 'SELECT * FROM orders',
            calls: 50,
            [total]: 750,
            [mean]: 15,
            rows: 500,
          }),
          row({
            query: 'SELECT * FROM products',
            calls: 200,
            [total]: 500,
            [mean]: 2.5,
            rows: 2000,
          }),
        ]
      : undefined
  );
  return { driver, executeResultSet: driver.executeResultSet };
}

function executedQuery(executeResultSet: ReturnType<typeof vi.fn<ExecuteResultSet>>): string {
  return String(executeResultSet.mock.lastCall?.[0]);
}

describe(TopQueriesCalc, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    extensionUtils.checkExtension.mockResolvedValue(extensionStatus(true));
  });

  it('sorts by total_time on PostgreSQL 12 when sorting by total', async () => {
    const { driver, executeResultSet } = createDriver(12);

    const result = await new TopQueriesCalc(driver).getTopQueriesByTime(3, 'total');

    expect(result).toContain('Top 3 slowest queries by total execution time');
    expect(result).toContain('SELECT * FROM users');
    expect(executedQuery(executeResultSet)).toContain('total_time');
    expect(executedQuery(executeResultSet)).toContain('ORDER BY total_time DESC');
  });

  it('sorts by mean_time on PostgreSQL 12 when sorting by mean', async () => {
    const { driver, executeResultSet } = createDriver(12);

    const result = await new TopQueriesCalc(driver).getTopQueriesByTime(3, 'mean');

    expect(result).toContain('Top 3 slowest queries by mean execution time per call');
    expect(result).toContain('SELECT * FROM orders');
    expect(executedQuery(executeResultSet)).toContain('mean_time');
    expect(executedQuery(executeResultSet)).toContain('ORDER BY mean_time DESC');
  });

  it('sorts by total_exec_time on PostgreSQL 13 when sorting by total', async () => {
    const { driver, executeResultSet } = createDriver(13);

    const result = await new TopQueriesCalc(driver).getTopQueriesByTime(3, 'total');

    expect(result).toContain('Top 3 slowest queries by total execution time');
    expect(result).toContain('SELECT * FROM users');
    expect(executedQuery(executeResultSet)).toContain('total_exec_time');
    expect(executedQuery(executeResultSet)).toContain('ORDER BY total_exec_time DESC');
  });

  it('sorts by mean_exec_time on PostgreSQL 13 when sorting by mean', async () => {
    const { driver, executeResultSet } = createDriver(13);

    const result = await new TopQueriesCalc(driver).getTopQueriesByTime(3, 'mean');

    expect(result).toContain('Top 3 slowest queries by mean execution time per call');
    expect(result).toContain('SELECT * FROM orders');
    expect(executedQuery(executeResultSet)).toContain('mean_exec_time');
    expect(executedQuery(executeResultSet)).toContain('ORDER BY mean_exec_time DESC');
  });

  it('returns installation instructions when the extension is not installed', async () => {
    const { driver, executeResultSet } = createDriver(13);
    extensionUtils.checkExtension.mockResolvedValue(extensionStatus(false));

    const result = await new TopQueriesCalc(driver).getTopQueriesByTime(3);

    expect(result).toContain('extension is required to report');
    expect(result).toContain('CREATE EXTENSION');
    expect(executeResultSet).not.toHaveBeenCalled();
  });

  it('reports a database error instead of throwing', async () => {
    const { driver, executeResultSet } = createDriver(13);
    executeResultSet.mockRejectedValue(new Error('Database error'));

    const result = await new TopQueriesCalc(driver).getTopQueriesByTime(3);

    expect(result).toContain('Error getting slow queries: Database error');
  });

  it('aliases the PostgreSQL 12 columns and zeroes wal_bytes in resource queries', async () => {
    const { driver, executeResultSet } = createDriver(12);

    await new TopQueriesCalc(driver).getTopResourceQueries(0.05);

    const query = executedQuery(executeResultSet);
    expect(query).toContain('stddev_time AS stddev_exec_time');
    expect(query).toContain('total_time AS total_exec_time');
    expect(query).toContain('mean_time AS mean_exec_time');
    expect(query).toContain('0 AS wal_bytes');
  });

  it('applies the given threshold to every resource fraction', async () => {
    const { driver, executeResultSet } = createDriver(13);

    await new TopQueriesCalc(driver).getTopResourceQueries(0.25);

    const query = executedQuery(executeResultSet);
    expect(query.match(/_frac > 0\.25/gu)).toHaveLength(5);
  });

  it('uses the PostgreSQL 13 columns and wal_bytes in resource queries', async () => {
    const { driver, executeResultSet } = createDriver(13);

    await new TopQueriesCalc(driver).getTopResourceQueries(0.05);

    const query = executedQuery(executeResultSet);
    expect(query).toContain('stddev_exec_time');
    expect(query).toContain('total_exec_time');
    expect(query).toContain('mean_exec_time');
    expect(query).toContain('wal_bytes');
  });
});
