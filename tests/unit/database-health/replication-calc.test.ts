import { describe, expect, it } from 'vitest';

import { ReplicationCalc } from '../../../src/database-health/replication-calc.ts';
import { QueryCancelledError, QueryTimeoutError } from '../../../src/sql/sql-driver.ts';
import type { Row } from '../../../src/sql/sql-driver.ts';
import { fakeExecutor } from '../../support/fake-executor.ts';
import { databaseError } from '../../support/fake-pool.ts';

function replicaExecutor(options: { lag?: Row[]; lagError?: Error; slots?: Row[] }) {
  return fakeExecutor((query) => {
    if (query.includes('pg_is_in_recovery()') && !query.includes('replication_lag')) {
      return [{ pg_is_in_recovery: true }];
    }
    if (query.includes('server_version_num')) {
      return [{ server_version_num: '160000' }];
    }
    if (query.includes('replication_lag')) {
      if (options.lagError) {
        throw options.lagError;
      }
      return options.lag ?? [{ replication_lag: '0' }];
    }
    if (query.includes('pg_replication_slots')) {
      return options.slots ?? [];
    }
    return [];
  });
}

describe('replicationHealthCheck', () => {
  it('reports a NULL lag without an error and still reports the rest', async () => {
    const calc = new ReplicationCalc(replicaExecutor({ lag: [{ replication_lag: null }] }));

    const report = await calc.replicationHealthCheck();

    expect(report).toBe(
      'This is a replica database.\nWARNING: Replica is not actively replicating from primary!\n\nNo replication slots found.'
    );
  });

  it('names the database only for a logical replication slot', async () => {
    const calc = new ReplicationCalc(
      replicaExecutor({
        slots: [
          { slot_name: 'slot_a', database: null, active: true },
          { slot_name: 'slot_b', database: 'app', active: true },
        ],
      })
    );

    const report = await calc.replicationHealthCheck();

    expect(report).toContain('- slot_a\n');
    expect(report).toContain('- slot_b (database: app)');
  });
});

describe('replicationHealthCheck when the lag query fails', () => {
  it('still reports when Postgres rejects the query', async () => {
    const calc = new ReplicationCalc(
      replicaExecutor({ lagError: databaseError('function pg_last_xact_replay_timestamp() does not exist', '42883') })
    );

    const report = await calc.replicationHealthCheck();

    expect(report).toContain('This is a replica database.');
  });

  it('rejects when the call was cancelled', async () => {
    const calc = new ReplicationCalc(replicaExecutor({ lagError: new QueryCancelledError() }));

    await expect(calc.replicationHealthCheck()).rejects.toThrow('Query cancelled');
  });

  it('rejects when the probe timed out instead of reporting the feature as unavailable', async () => {
    const calc = new ReplicationCalc(replicaExecutor({ lagError: new QueryTimeoutError(30) }));

    await expect(calc.replicationHealthCheck()).rejects.toBeInstanceOf(QueryTimeoutError);
  });
});
