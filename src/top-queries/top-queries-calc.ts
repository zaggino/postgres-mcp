import { errorMessage } from '../errors.ts';
import { toJson } from '../json.ts';
import { logLine } from '../log.ts';
import { checkExtension, getPostgresVersion } from '../sql/extension-utils.ts';
import { literal } from '../sql/literal.ts';
import type { SqlExecutor } from '../sql/safe-sql.ts';
import { SafeSqlDriver, queryRows } from '../sql/safe-sql.ts';

export const PG_STAT_STATEMENTS = 'pg_stat_statements';

const INSTALL_PG_STAT_STATEMENTS_MESSAGE =
  'The pg_stat_statements extension is required to ' +
  'report slow queries, but it is not currently ' +
  'installed.\n\n' +
  'You can install it by running: ' +
  '`CREATE EXTENSION pg_stat_statements;`\n\n' +
  '**What does it do?** It records statistics (like ' +
  'execution time, number of calls, rows returned) for ' +
  'every query executed against the database.\n\n' +
  "**Is it safe?** Installing 'pg_stat_statements' is " +
  'generally safe and a standard practice for performance ' +
  'monitoring. It adds overhead by tracking statistics, ' +
  'but this is usually negligible unless under extreme load.';

/** Column names for the pg_stat_statements view, which vary by PostgreSQL version. */
export interface PgStatStatementsColumns {
  meanTime: string;
  stddevTime: string;
  totalTime: string;
  /** Full fraction expression. */
  walBytesFrac: string;
  /** Full SELECT expression (handles the missing column in PG12). */
  walBytesSelect: string;
}

/**
 * Version-appropriate pg_stat_statements column names.
 *
 * PostgreSQL 13 introduced pg_stat_statements v2.0: the timing columns were
 * renamed (`total_time` to `total_exec_time`, etc.) and `wal_bytes` was added.
 * See https://www.postgresql.org/docs/13/release-13.html#id-1.11.6.11.4
 */
function getPgStatStatementsColumns(pgVersion: number): PgStatStatementsColumns {
  if (pgVersion >= 13) {
    // PostgreSQL 13+ with pg_stat_statements v2.0
    return {
      totalTime: 'total_exec_time',
      meanTime: 'mean_exec_time',
      stddevTime: 'stddev_exec_time',
      walBytesSelect: 'wal_bytes',
      walBytesFrac: 'wal_bytes / NULLIF(SUM(wal_bytes) OVER (), 0) AS total_wal_bytes_frac',
    };
  }

  // PostgreSQL 12 and older with pg_stat_statements v1.x
  return {
    totalTime: 'total_time',
    meanTime: 'mean_time',
    stddevTime: 'stddev_time',
    walBytesSelect: '0 AS wal_bytes', // Column doesn't exist in PG12
    walBytesFrac: '0 AS total_wal_bytes_frac',
  };
}

/** Tool for retrieving the slowest SQL queries. */
export class TopQueriesCalc {
  private readonly sqlDriver: SqlExecutor;

  constructor(sqlDriver: SqlExecutor) {
    this.sqlDriver = sqlDriver;
  }

  /**
   * Reports the slowest SQL queries based on execution time: by `"total"`
   * execution time or by `"mean"` execution time per call (default).
   */
  async getTopQueriesByTime(limit = 10, sortBy: 'total' | 'mean' = 'mean'): Promise<string> {
    try {
      const extensionStatus = await checkExtension(this.sqlDriver, PG_STAT_STATEMENTS, false);

      if (!extensionStatus.isInstalled) {
        logLine(`Extension ${PG_STAT_STATEMENTS} is not installed`);
        // Return installation instructions if the extension is not installed
        return INSTALL_PG_STAT_STATEMENTS_MESSAGE;
      }

      // Get version-appropriate column names
      const pgVersion = await getPostgresVersion(this.sqlDriver);
      const cols = getPgStatStatementsColumns(pgVersion);

      // Determine which column to sort by based on the sortBy parameter
      const orderByColumn = sortBy === 'total' ? cols.totalTime : cols.meanTime;

      const query = `
                SELECT
                    query,
                    calls,
                    ${cols.totalTime},
                    ${cols.meanTime},
                    rows
                FROM pg_stat_statements
                ORDER BY ${orderByColumn} DESC
                LIMIT {};
            `;
      const slowQueryRows = await SafeSqlDriver.executeParamQuery(this.sqlDriver, query, [limit]);

      // Create result description based on sort criteria
      const criteria = sortBy === 'total' ? 'total execution time' : 'mean execution time per call';

      return `Top ${slowQueryRows.length} slowest queries by ${criteria}:\n${toJson(slowQueryRows)}`;
    } catch (error) {
      const message = errorMessage(error);
      logLine(`Error getting slow queries: ${message}`);
      return `Error getting slow queries: ${message}`;
    }
  }

  /**
   * Reports the most time consuming queries based on a resource blend;
   * `fracThreshold` filters queries by their fraction of total usage.
   */
  async getTopResourceQueries(fracThreshold = 0.05): Promise<string> {
    try {
      const extensionStatus = await checkExtension(this.sqlDriver, PG_STAT_STATEMENTS, false);

      if (!extensionStatus.isInstalled) {
        logLine(`Extension ${PG_STAT_STATEMENTS} is not installed`);
        // Return installation instructions if the extension is not installed
        return INSTALL_PG_STAT_STATEMENTS_MESSAGE;
      }

      // Get version-appropriate column names
      const pgVersion = await getPostgresVersion(this.sqlDriver);
      const cols = getPgStatStatementsColumns(pgVersion);

      const threshold = literal(fracThreshold);
      const query = `
                WITH resource_fractions AS (
                    SELECT
                        query,
                        calls,
                        rows,
                        ${cols.totalTime} AS total_exec_time,
                        ${cols.meanTime} AS mean_exec_time,
                        ${cols.stddevTime} AS stddev_exec_time,
                        shared_blks_hit,
                        shared_blks_read,
                        shared_blks_dirtied,
                        ${cols.walBytesSelect},
                        ${cols.totalTime} / NULLIF(SUM(${cols.totalTime}) OVER (), 0)
                            AS total_exec_time_frac,
                        (shared_blks_hit + shared_blks_read)
                            / NULLIF(SUM(shared_blks_hit + shared_blks_read) OVER (), 0)
                            AS shared_blks_accessed_frac,
                        shared_blks_read / NULLIF(SUM(shared_blks_read) OVER (), 0)
                            AS shared_blks_read_frac,
                        shared_blks_dirtied / NULLIF(SUM(shared_blks_dirtied) OVER (), 0)
                            AS shared_blks_dirtied_frac,
                        ${cols.walBytesFrac}
                    FROM pg_stat_statements
                )
                SELECT
                    query,
                    calls,
                    rows,
                    total_exec_time,
                    mean_exec_time,
                    stddev_exec_time,
                    total_exec_time_frac,
                    shared_blks_accessed_frac,
                    shared_blks_read_frac,
                    shared_blks_dirtied_frac,
                    total_wal_bytes_frac,
                    shared_blks_hit,
                    shared_blks_read,
                    shared_blks_dirtied,
                    wal_bytes
                FROM resource_fractions
                WHERE
                    total_exec_time_frac > ${threshold}
                    OR shared_blks_accessed_frac > ${threshold}
                    OR shared_blks_read_frac > ${threshold}
                    OR shared_blks_dirtied_frac > ${threshold}
                    OR total_wal_bytes_frac > ${threshold}
                ORDER BY total_exec_time DESC
            `;

      const slowQueryRows = await queryRows(this.sqlDriver, query);

      return toJson(slowQueryRows);
    } catch (error) {
      const message = errorMessage(error);
      logLine(`Error getting resource-intensive queries: ${message}`);
      return `Error resource-intensive queries: ${message}`;
    }
  }
}
