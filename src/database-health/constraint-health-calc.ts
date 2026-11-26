import type { SqlExecutor } from '../sql/safe-sql.ts';

interface ConstraintMetrics {
  name: string;
  referencedSchema: string | null;
  referencedTable: string | null;
  schema: string;
  table: string;
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export class ConstraintHealthCalc {
  private readonly sqlDriver: SqlExecutor;

  constructor(sqlDriver: SqlExecutor) {
    this.sqlDriver = sqlDriver;
  }

  /** Describes any invalid constraints found in the database. */
  async invalidConstraintsCheck(): Promise<string> {
    const metrics = await this.getInvalidConstraints();

    if (metrics.length === 0) {
      return 'No invalid constraints found.';
    }

    const result = ['Invalid constraints found:'];
    for (const metric of metrics) {
      if (metric.referencedTable) {
        result.push(
          `Constraint '${metric.name}' on table '${metric.schema}.${metric.table}' ` +
            `referencing '${metric.referencedSchema}.${metric.referencedTable}' is invalid`
        );
      } else {
        result.push(`Constraint '${metric.name}' on table '${metric.schema}.${metric.table}' is invalid`);
      }
    }
    return result.join('\n');
  }

  private async getInvalidConstraints(): Promise<ConstraintMetrics[]> {
    const results = await this.sqlDriver.executeQuery(`
            SELECT
                nsp.nspname AS schema,
                rel.relname AS table,
                con.conname AS name,
                fnsp.nspname AS referenced_schema,
                frel.relname AS referenced_table
            FROM
                pg_catalog.pg_constraint con
            INNER JOIN
                pg_catalog.pg_class rel ON rel.oid = con.conrelid
            LEFT JOIN
                pg_catalog.pg_class frel ON frel.oid = con.confrelid
            LEFT JOIN
                pg_catalog.pg_namespace nsp ON nsp.oid = con.connamespace
            LEFT JOIN
                pg_catalog.pg_namespace fnsp ON fnsp.oid = frel.relnamespace
            WHERE
                con.convalidated = 'f'
        `);

    if (!results) {
      return [];
    }

    return results.map(({ cells }) => ({
      schema: String(cells.schema),
      table: String(cells.table),
      name: String(cells.name),
      referencedSchema: nullableText(cells.referenced_schema),
      referencedTable: nullableText(cells.referenced_table),
    }));
  }
}
