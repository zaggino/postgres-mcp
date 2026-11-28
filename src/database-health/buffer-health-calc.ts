import { nullableNumeric } from '../sql/cells.ts';
import type { SqlExecutor } from '../sql/safe-sql.ts';

async function hitRateReport(sqlDriver: SqlExecutor, query: string, label: string, threshold: number): Promise<string> {
  const [row] = await sqlDriver.executeQuery(query);
  // NULL when there are no statistics yet; the aggregate always returns one row.
  const rate = row ? nullableNumeric(row, 'rate') : null;

  if (rate === null) {
    return `No ${label.toLowerCase()} cache statistics available.`;
  }

  const hitRate = rate * 100;
  const thresholdPct = threshold * 100;
  const position = hitRate >= thresholdPct ? 'above' : 'below';

  return `${label} cache hit rate: ${hitRate.toFixed(1)}% (${position} ${thresholdPct.toFixed(1)}% threshold)`;
}

export class BufferHealthCalc {
  private readonly sqlDriver: SqlExecutor;

  constructor(sqlDriver: SqlExecutor) {
    this.sqlDriver = sqlDriver;
  }

  /** Index cache hit rate as a percentage and its comparison to `threshold`. */
  indexHitRate(threshold = 0.95): Promise<string> {
    return hitRateReport(
      this.sqlDriver,
      `
            SELECT
                (sum(idx_blks_hit)) / nullif(sum(idx_blks_hit + idx_blks_read), 0) AS rate
            FROM
                pg_statio_user_indexes
        `,
      'Index',
      threshold
    );
  }

  /** Table cache hit rate as a percentage and its comparison to `threshold`. */
  tableHitRate(threshold = 0.95): Promise<string> {
    return hitRateReport(
      this.sqlDriver,
      `
            SELECT
                sum(heap_blks_hit) / nullif(sum(heap_blks_hit + heap_blks_read), 0) AS rate
            FROM
                pg_statio_user_tables
        `,
      'Table',
      threshold
    );
  }
}
