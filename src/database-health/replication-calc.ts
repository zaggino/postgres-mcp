import * as cell from '../sql/cells.ts';
import type { SqlExecutor } from '../sql/safe-sql.ts';
import { queryRows } from '../sql/safe-sql.ts';
import type { Row } from '../sql/sql-driver.ts';
import { isCheckLocalFailure } from './check-failure.ts';

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
    return cell.boolean(cell.single(result), 'pg_is_in_recovery');
  }

  private async getReplicationLag(): Promise<number | null> {
    // Use appropriate functions based on PostgreSQL version
    const lagCondition =
      (await this.getServerVersion()) >= 100_000
        ? 'pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn()'
        : 'pg_last_xlog_receive_location() = pg_last_xlog_replay_location()';

    const result = await this.#tryQuery(
      `
                SELECT
                    CASE
                        WHEN NOT pg_is_in_recovery() OR ${lagCondition} THEN 0
                        ELSE EXTRACT (EPOCH FROM NOW() - pg_last_xact_replay_timestamp())
                    END
                AS replication_lag
            `
    );
    if (result === null) {
      return null;
    }
    // The query has no FROM, so it returns one row. A NULL lag (nothing replayed yet) is unknown.
    return cell.nullableNumeric(cell.single(result), 'replication_lag');
  }

  private async getReplicationSlots(): Promise<ReplicationSlot[]> {
    if ((await this.getServerVersion()) < 90_400) {
      return [];
    }

    const result = await this.#tryQuery(
      `
                SELECT
                    slot_name,
                    database,
                    active
                FROM pg_replication_slots
            `
    );
    return result === null ? [] : result.map(toReplicationSlot);
  }

  private async isReplicating(): Promise<boolean> {
    const result = await this.#tryQuery('SELECT state FROM pg_stat_replication');
    return result !== null && result.length > 0;
  }

  /** PostgreSQL server version as a number (e.g. 100000 for version 10.0). */
  private async getServerVersion(): Promise<number> {
    if (this.serverVersion === null) {
      const result = await queryRows(this.sqlDriver, 'SHOW server_version_num');
      this.serverVersion = Number.parseInt(cell.text(cell.single(result), 'server_version_num'), 10);
    }
    return this.serverVersion;
  }

  /**
   * Run an optional probe. Returns null when the server rejects it (a missing view or privilege, an older
   * server), so the feature counts as unsupported; any other failure, such as a cancellation, propagates.
   */
  async #tryQuery(sql: string): Promise<Row[] | null> {
    try {
      return await queryRows(this.sqlDriver, sql);
    } catch (error) {
      if (isCheckLocalFailure(error)) {
        return null;
      }
      throw error;
    }
  }
}
