import { nullableText, text } from '../sql/cells.ts';
import type { Row, SqlExecutor } from '../sql/safe-sql.ts';

interface ConstraintMetrics {
  name: string;
  referencedSchema: string | null;
  referencedTable: string | null;
  schema: string;
  table: string;
}

function toConstraintMetrics(row: Row): ConstraintMetrics {
  return {
    schema: text(row, 'schema'),
    table: text(row, 'table'),
    name: text(row, 'name'),
    referencedSchema: nullableText(row, 'referenced_schema'),
    referencedTable: nullableText(row, 'referenced_table'),
  };
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

    return results.map(toConstraintMetrics);
  }
}
