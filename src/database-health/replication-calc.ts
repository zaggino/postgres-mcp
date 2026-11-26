import type { SqlExecutor } from '../sql/safe-sql.ts';

interface ReplicationSlot {
  active: boolean;
  database: unknown;
  slotName: string;
}

interface ReplicationMetrics {
  isReplica: boolean;
  isReplicating: boolean;
  replicationLagSeconds: number | null;
  replicationSlots: ReplicationSlot[];
}

type Feature = 'replication_lag' | 'replication_slots' | 'replicating';

function describeSlot(slot: ReplicationSlot): string {
  // Physical slots have no database; it is reported as "None".
  const database = slot.database === null || slot.database === undefined ? 'None' : String(slot.database);
  return `- ${slot.slotName} (database: ${database})`;
}

export class ReplicationCalc {
  private readonly featureSupport = new Map<Feature, boolean>();
  private serverVersion: number | null = null;
  private readonly sqlDriver: SqlExecutor;

  constructor(sqlDriver: SqlExecutor) {
    this.sqlDriver = sqlDriver;
  }

  /** Check replication health including lag and slots. */
  async replicationHealthCheck(): Promise<string> {
    const metrics = await this.getReplicationMetrics();
    const result: string[] = [];

    if (metrics.isReplica) {
      result.push('This is a replica database.');
      // Check replication status
      if (metrics.isReplicating) {
        result.push('Replica is actively replicating from primary.');
      } else {
        result.push('WARNING: Replica is not actively replicating from primary!');
      }

      // Check replication lag
      if (metrics.replicationLagSeconds !== null) {
        if (metrics.replicationLagSeconds === 0) {
          result.push('No replication lag detected.');
        } else {
          result.push(`Replication lag: ${metrics.replicationLagSeconds.toFixed(1)} seconds`);
        }
      }
    } else {
      result.push('This is a primary database.');
      if (metrics.isReplicating) {
        result.push('Has active replicas connected.');
      } else {
        result.push('No active replicas connected.');
      }
    }

    // Check replication slots for both primary and replica
    if (metrics.replicationSlots.length > 0) {
      const activeSlots = metrics.replicationSlots.filter((s) => s.active);
      const inactiveSlots = metrics.replicationSlots.filter((s) => !s.active);

      if (activeSlots.length > 0) {
        result.push('\nActive replication slots:', ...activeSlots.map(describeSlot));
      }

      if (inactiveSlots.length > 0) {
        result.push('\nInactive replication slots:', ...inactiveSlots.map(describeSlot));
      }
    } else {
      result.push('\nNo replication slots found.');
    }

    return result.join('\n');
  }

  private async getReplicationMetrics(): Promise<ReplicationMetrics> {
    return {
      isReplica: await this.isReplica(),
      replicationLagSeconds: await this.getReplicationLag(),
      isReplicating: await this.isReplicating(),
      replicationSlots: await this.getReplicationSlots(),
    };
  }

  private async isReplica(): Promise<boolean> {
    const result = await this.sqlDriver.executeQuery('SELECT pg_is_in_recovery()');
    return Boolean(result?.[0]?.cells.pg_is_in_recovery);
  }

  private async getReplicationLag(): Promise<number | null> {
    if (!this.featureSupported('replication_lag')) {
      return null;
    }

    // Use appropriate functions based on PostgreSQL version
    const lagCondition =
      (await this.getServerVersion()) >= 100_000
        ? 'pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn()'
        : 'pg_last_xlog_receive_location() = pg_last_xlog_replay_location()';

    try {
      const result = await this.sqlDriver.executeQuery(`
                SELECT
                    CASE
                        WHEN NOT pg_is_in_recovery() OR ${lagCondition} THEN 0
                        ELSE EXTRACT (EPOCH FROM NOW() - pg_last_xact_replay_timestamp())
                    END
                AS replication_lag
            `);
      const first = result?.[0];
      if (!first) {
        return null;
      }
      const lag = first.cells.replication_lag;
      if (lag === null || lag === undefined) {
        // A NULL lag (nothing replayed yet) disables the feature, as a failed query does.
        throw new TypeError('replication_lag is NULL');
      }
      return Number(lag);
    } catch {
      this.featureSupport.set('replication_lag', false);
      return null;
    }
  }

  private async getReplicationSlots(): Promise<ReplicationSlot[]> {
    if ((await this.getServerVersion()) < 90_400 || !this.featureSupported('replication_slots')) {
      return [];
    }

    try {
      const result = await this.sqlDriver.executeQuery(`
                SELECT
                    slot_name,
                    database,
                    active
                FROM pg_replication_slots
            `);
      if (result === null) {
        return [];
      }
      return result.map(({ cells }) => ({
        slotName: String(cells.slot_name),
        database: cells.database,
        active: Boolean(cells.active),
      }));
    } catch {
      this.featureSupport.set('replication_slots', false);
      return [];
    }
  }

  private async isReplicating(): Promise<boolean> {
    if (!this.featureSupported('replicating')) {
      return false;
    }

    try {
      const result = await this.sqlDriver.executeQuery('SELECT state FROM pg_stat_replication');
      return result !== null && result.length > 0;
    } catch {
      this.featureSupport.set('replicating', false);
      return false;
    }
  }

  /** PostgreSQL server version as a number (e.g. 100000 for version 10.0). */
  private async getServerVersion(): Promise<number> {
    if (this.serverVersion === null) {
      const result = await this.sqlDriver.executeQuery('SHOW server_version_num');
      const first = result?.[0];
      this.serverVersion = first ? Number.parseInt(String(first.cells.server_version_num), 10) : 0;
    }
    return this.serverVersion;
  }

  private featureSupported(feature: Feature): boolean {
    return this.featureSupport.get(feature) ?? true;
  }
}
