import type { SqlExecutor } from "../sql/safe-sql.ts";

async function hitRateReport(
  sqlDriver: SqlExecutor,
  query: string,
  label: string,
  threshold: number
): Promise<string> {
  const result = await sqlDriver.executeQuery(query);
  const rate = result?.[0]?.cells.rate;

  if (rate === null || rate === undefined) {
    return `No ${label.toLowerCase()} cache statistics available.`;
  }

  const hitRate = Number(rate) * 100;
  const thresholdPct = threshold * 100;
  const position = hitRate >= thresholdPct ? "above" : "below";

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
      "Index",
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
      "Table",
      threshold
    );
  }
}
