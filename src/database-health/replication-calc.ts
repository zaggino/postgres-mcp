import * as cell from '../sql/cells.ts';
import type { SqlExecutor } from '../sql/safe-sql.ts';
import { queryRows } from '../sql/safe-sql.ts';
import type { Row } from '../sql/sql-driver.ts';

interface ReplicationSlot {
  active: boolean;
  database: string | null;
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
  // Physical slots have no database, so only a logical slot names one.
  return slot.database === null ? `- ${slot.slotName}` : `- ${slot.slotName} (database: ${slot.database})`;
}

function toReplicationSlot(row: Row): ReplicationSlot {
  return {
    slotName: cell.text(row, 'slot_name'),
    database: cell.nullableText(row, 'database'),
    active: cell.boolean(row, 'active'),
  };
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
    const result = await queryRows(this.sqlDriver, 'SELECT pg_is_in_recovery()');
    const [row] = result;
    return row ? cell.boolean(row, 'pg_is_in_recovery') : false;
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

    let result: Row[];
    try {
      result = await queryRows(
        this.sqlDriver,
        `
                SELECT
                    CASE
                        WHEN NOT pg_is_in_recovery() OR ${lagCondition} THEN 0
                        ELSE EXTRACT (EPOCH FROM NOW() - pg_last_xact_replay_timestamp())
                    END
                AS replication_lag
            `
      );
    } catch {
      // Only a failing query marks the feature unsupported.
      this.featureSupport.set('replication_lag', false);
      return null;
    }
    const [first] = result;
    // A NULL lag (nothing replayed yet) is unknown for this call only; a later call may have a lag.
    return first ? cell.nullableNumeric(first, 'replication_lag') : null;
  }

  private async getReplicationSlots(): Promise<ReplicationSlot[]> {
    if ((await this.getServerVersion()) < 90_400 || !this.featureSupported('replication_slots')) {
      return [];
    }

    let result: Row[];
    try {
      result = await queryRows(
        this.sqlDriver,
        `
                SELECT
                    slot_name,
                    database,
                    active
                FROM pg_replication_slots
            `
      );
    } catch {
      this.featureSupport.set('replication_slots', false);
      return [];
    }
    return result.map(toReplicationSlot);
  }

  private async isReplicating(): Promise<boolean> {
    if (!this.featureSupported('replicating')) {
      return false;
    }

    try {
      const result = await queryRows(this.sqlDriver, 'SELECT state FROM pg_stat_replication');
      return result.length > 0;
    } catch {
      this.featureSupport.set('replicating', false);
      return false;
    }
  }

  /** PostgreSQL server version as a number (e.g. 100000 for version 10.0). */
  private async getServerVersion(): Promise<number> {
    if (this.serverVersion === null) {
      const result = await queryRows(this.sqlDriver, 'SHOW server_version_num');
      const [first] = result;
      this.serverVersion = first ? Number.parseInt(cell.text(first, 'server_version_num'), 10) : 0;
    }
    return this.serverVersion;
  }

  private featureSupported(feature: Feature): boolean {
    return this.featureSupport.get(feature) ?? true;
  }
}
