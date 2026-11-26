import type { SqlExecutor } from '../sql/safe-sql.ts';
import { SafeSqlDriver } from '../sql/safe-sql.ts';

interface TransactionIdMetrics {
  isHealthy: boolean;
  schema: string;
  table: string;
  transactionsLeft: number;
}

export class VacuumHealthCalc {
  private readonly maxValue: number;
  private readonly sqlDriver: SqlExecutor;
  private readonly threshold: number;

  constructor(sqlDriver: SqlExecutor, threshold = 10_000_000, maxValue = 2_146_483_648) {
    this.sqlDriver = sqlDriver;
    this.threshold = threshold;
    this.maxValue = maxValue;
  }

  /** Check if any tables are approaching transaction ID wraparound. */
  async transactionIdDangerCheck(): Promise<string> {
    const metrics = await this.getTransactionIdMetrics();

    if (metrics.length === 0) {
      return 'No tables found with transaction ID wraparound danger.';
    }

    // Sort by transactions left ascending to show most critical first
    const sorted = metrics.toSorted((a, b) => a.transactionsLeft - b.transactionsLeft);

    const unhealthy = sorted.filter((m) => !m.isHealthy);
    if (unhealthy.length === 0) {
      return 'All tables have healthy transaction ID age.';
    }

    const result = ['Tables approaching transaction ID wraparound:'];
    for (const metric of unhealthy) {
      result.push(
        `Table '${metric.schema}.${metric.table}' has ${metric.transactionsLeft.toLocaleString('en-US')} transactions ` +
          `remaining before wraparound (threshold: ${this.threshold.toLocaleString('en-US')})`
      );
    }
    return result.join('\n');
  }

  private async getTransactionIdMetrics(): Promise<TransactionIdMetrics[]> {
    const results = await SafeSqlDriver.executeParamQuery(
      this.sqlDriver,
      `
            SELECT
                n.nspname AS schema,
                c.relname AS table,
                {} - GREATEST(AGE(c.relfrozenxid), AGE(t.relfrozenxid)) AS transactions_left
            FROM
                pg_class c
            INNER JOIN
                pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            LEFT JOIN
                pg_class t ON c.reltoastrelid = t.oid
            WHERE
                c.relkind = 'r'
                AND ({} - GREATEST(AGE(c.relfrozenxid), AGE(t.relfrozenxid))) < {}
            ORDER BY
                3, 1, 2
        `,
      [this.maxValue, this.maxValue, this.threshold]
    );

    if (!results) {
      return [];
    }

    return results.map(({ cells }) => {
      const transactionsLeft = Number(cells.transactions_left);
      return {
        schema: String(cells.schema),
        table: String(cells.table),
        transactionsLeft,
        isHealthy: transactionsLeft >= this.threshold,
      };
    });
  }
}
