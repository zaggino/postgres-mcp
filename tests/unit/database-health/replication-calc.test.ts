import { describe, expect, it } from 'vitest';

import { ReplicationCalc } from '../../../src/database-health/replication-calc.ts';
import type { Row } from '../../../src/sql/safe-sql.ts';
import { fakeExecutor } from '../../support/fake-executor.ts';

function replicaExecutor(options: { lags?: Row[][]; slots?: Row[] }) {
  const lags = [...(options.lags ?? [])];
  return fakeExecutor((query) => {
    if (query.includes('pg_is_in_recovery()') && !query.includes('replication_lag')) {
      return [{ pg_is_in_recovery: true }];
    }
    if (query.includes('server_version_num')) {
      return [{ server_version_num: '160000' }];
    }
    if (query.includes('replication_lag')) {
      return lags.shift();
    }
    if (query.includes('pg_replication_slots')) {
      return options.slots ?? [];
    }
    if (query.includes('pg_stat_replication')) {
      return [];
    }
    return [];
  });
}

describe('replicationHealthCheck', () => {
  it('reports the lag of a later check after an earlier one found it NULL', async () => {
    const calc = new ReplicationCalc(
      replicaExecutor({ lags: [[{ replication_lag: null }], [{ replication_lag: '2.5' }]] })
    );

    await calc.replicationHealthCheck();
    const second = await calc.replicationHealthCheck();

    expect(second).toContain('Replication lag: 2.5 seconds');
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
