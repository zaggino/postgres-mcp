import { afterEach, expect, test, vi } from 'vitest';

import { DatabaseHealthTool } from '../../../src/database-health/database-health.ts';
import { QueryCancelledError } from '../../../src/sql/sql-driver.ts';
import { fakeExecutor } from '../../support/fake-executor.ts';
import { databaseError } from '../../support/fake-pool.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

test('a failing check reports its error on its own line and the other checks still run', async () => {
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const executor = fakeExecutor((query) => {
    if (query.includes('pg_stat_activity')) {
      throw databaseError('permission denied for pg_stat_activity', '42501');
    }
    return [{ rate: '0.99' }];
  });

  const report = await new DatabaseHealthTool(executor).health('connection,buffer');

  expect(report).toBe(
    'Connection health: Error: permission denied for pg_stat_activity\n' +
      'Buffer health for indexes: Index cache hit rate: 99.0% (above 95.0% threshold)\n' +
      'Buffer health for tables: Table cache hit rate: 99.0% (above 95.0% threshold)\n'
  );
});

test('a connection failure aborts the report after one attempt instead of repeating per check', async () => {
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const executor = fakeExecutor(() => {
    throw new Error('socket hang up');
  });

  const report = await new DatabaseHealthTool(executor).health('all');

  expect(report).toBe('Error calculating database health: socket hang up');
  expect(executor.executeResultSet).toHaveBeenCalledOnce();
});

test('a cancelled call stops the whole report', async () => {
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const executor = fakeExecutor(() => {
    throw new QueryCancelledError();
  });

  const report = await new DatabaseHealthTool(executor).health('connection,buffer');

  expect(report).toBe('Error calculating database health: Query cancelled');
});
