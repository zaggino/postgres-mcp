import * as cell from '../sql/cells.ts';
import type { SqlExecutor } from '../sql/safe-sql.ts';
import { queryRows } from '../sql/safe-sql.ts';

export class ConnectionHealthCalc {
  private readonly maxIdleConnections: number;
  private readonly maxTotalConnections: number;
  private readonly sqlDriver: SqlExecutor;

  constructor(sqlDriver: SqlExecutor, maxTotalConnections = 500, maxIdleConnections = 100) {
    this.sqlDriver = sqlDriver;
    this.maxTotalConnections = maxTotalConnections;
    this.maxIdleConnections = maxIdleConnections;
  }

  /** Check if total number of connections is within healthy limits. */
  async totalConnectionsCheck(): Promise<string> {
    const total = await this.getTotalConnections();

    if (total <= this.maxTotalConnections) {
      return `Total connections healthy: ${total}`;
    }
    return `High number of connections: ${total} (max: ${this.maxTotalConnections})`;
  }

  /** Check if number of idle connections is within healthy limits. */
  async idleConnectionsCheck(): Promise<string> {
    const idle = await this.getIdleConnections();

    if (idle <= this.maxIdleConnections) {
      return `Idle connections healthy: ${idle}`;
    }
    return `High number of idle connections: ${idle} (max: ${this.maxIdleConnections})`;
  }

  /** Run all connection health checks and return combined results. */
  async connectionHealthCheck(): Promise<string> {
    const total = await this.getTotalConnections();
    const idle = await this.getIdleConnections();

    if (total > this.maxTotalConnections) {
      return `High number of connections: ${total}`;
    }
    if (idle > this.maxIdleConnections) {
      return `High number of connections idle in transaction: ${idle}`;
    }
    return `Connections healthy: ${total} total, ${idle} idle`;
  }

  private async getTotalConnections(): Promise<number> {
    const result = await queryRows(
      this.sqlDriver,
      `
            SELECT COUNT(*) as count
            FROM pg_stat_activity
        `
    );
    const [row] = result;
    return row ? cell.integer(row, 'count') : 0;
  }

  /** Number of connections that are idle in transaction. */
  private async getIdleConnections(): Promise<number> {
    const result = await queryRows(
      this.sqlDriver,
      `
            SELECT COUNT(*) as count
            FROM pg_stat_activity
            WHERE state = 'idle in transaction'
        `
    );
    const [row] = result;
    return row ? cell.integer(row, 'count') : 0;
  }
}
