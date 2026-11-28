import { afterEach, expect, test, vi } from 'vitest';

import { DatabaseHealthTool } from '../../../src/database-health/database-health.ts';
import { QueryCancelledError } from '../../../src/sql/sql-driver.ts';
import { fakeExecutor } from '../../support/fake-executor.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

test('a failing check reports its error on its own line and the other checks still run', async () => {
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const executor = fakeExecutor((query) => {
    if (query.includes('pg_stat_activity')) {
      throw new Error('permission denied for pg_stat_activity');
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

test('a cancelled call stops the whole report', async () => {
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const executor = fakeExecutor(() => {
    throw new QueryCancelledError();
  });

  const report = await new DatabaseHealthTool(executor).health('connection,buffer');

  expect(report).toBe('Error calculating database health: Query cancelled');
});
