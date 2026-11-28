import * as cell from '../sql/cells.ts';
import { identifier } from '../sql/literal.ts';
import type { SqlExecutor } from '../sql/safe-sql.ts';
import { SafeSqlDriver, queryRows } from '../sql/safe-sql.ts';
import type { Row } from '../sql/sql-driver.ts';

interface SequenceMetrics {
  column: string;
  columnType: string;
  isHealthy: boolean;
  lastValue: bigint;
  maxValue: bigint;
  readable: boolean;
  schema: string;
  sequence: string;
  table: string;
}

interface SequenceColumn {
  column: string;
  columnType: string;
  defaultValue: string;
  table: string;
}

function toSequenceColumn(row: Row): SequenceColumn {
  return {
    table: cell.text(row, 'table'),
    column: cell.text(row, 'column'),
    columnType: cell.text(row, 'column_type'),
    defaultValue: cell.text(row, 'default_value'),
  };
}

interface SequenceAttributes {
  lastValue: bigint;
  readable: boolean;
}

function toSequenceAttributes(row: Row): SequenceAttributes {
  return { readable: cell.boolean(row, 'readable'), lastValue: cell.bigint(row, 'last_value') };
}

const SMALLINT_MAX = 32_767n;
const INTEGER_MAX = 2_147_483_647n;
const BIGINT_MAX = 9_223_372_036_854_775_807n;
const NEXTVAL_REFERENCE = /nextval\(\(?'(?<reference>[^']+)'/u;

/** The largest value a sequence feeding a column of `columnType` can reach. */
function maxValueFor(columnType: string): bigint {
  if (columnType === 'smallint') {
    return SMALLINT_MAX;
  }
  return columnType === 'integer' ? INTEGER_MAX : BIGINT_MAX;
}

/** What percentage of the sequence has been used. */
function percentUsed(metric: SequenceMetrics): number {
  return metric.maxValue === 0n ? 0 : (Number(metric.lastValue) / Number(metric.maxValue)) * 100;
}

export class SequenceHealthCalc {
  private readonly sqlDriver: SqlExecutor;
  private readonly threshold: number;

  /** `threshold` is the fraction of sequence usage that triggers a warning. */
  constructor(sqlDriver: SqlExecutor, threshold = 0.9) {
    this.sqlDriver = sqlDriver;
    this.threshold = threshold;
  }

  /**
   * Parse schema and sequence name from a default value expression.
   *
   * Handles `nextval('id_seq'::regclass)`, `nextval(('id_seq'::text)::regclass)`,
   * `nextval('"UpperCaseSeq"'::regclass)` and `nextval('"Schema"."Seq"'::regclass)`.
   *
   * Sequence names containing literal dots (e.g. "my.seq") are not supported
   * and are incorrectly parsed as schema.name.
   */
  static parseSequenceName(defaultValue: string): [string, string] {
    // Extract the sequence reference from inside the single quotes
    const reference = NEXTVAL_REFERENCE.exec(defaultValue)?.groups?.reference;
    if (reference === undefined) {
      return ['public', ''];
    }

    // Remove quotes so the identifier can be quoted correctly
    const parts = reference.replaceAll('"', '').split('.');
    const [first = '', second = ''] = parts;
    if (parts.length === 1) {
      return ['public', first]; // Default to public schema
    }
    return [first, second];
  }

  /** Check if any sequences are approaching their maximum values. */
  async sequenceDangerCheck(): Promise<string> {
    const metrics = await this.getSequenceMetrics();

    if (metrics.length === 0) {
      return 'No sequences found in the database.';
    }

    // Sort by remaining values ascending to show most critical first
    const remainingOf = (m: SequenceMetrics): bigint => m.maxValue - m.lastValue;
    const sorted = metrics.toSorted((a, b) => {
      const diff = remainingOf(a) - remainingOf(b);
      if (diff === 0n) {
        return 0;
      }
      return diff < 0n ? -1 : 1;
    });

    const unhealthy = sorted.filter((m) => !m.isHealthy);
    if (unhealthy.length === 0) {
      return 'All sequences have healthy usage levels.';
    }

    const result = ['Sequences approaching maximum value:'];
    for (const metric of unhealthy) {
      const remaining = remainingOf(metric);
      result.push(
        `Sequence '${metric.schema}.${metric.sequence}' used for ${metric.table}.${metric.column} ` +
          `has used ${percentUsed(metric).toFixed(1)}% of available values ` +
          `(${metric.lastValue.toLocaleString('en-US')} of ${metric.maxValue.toLocaleString('en-US')}, ${remaining.toLocaleString('en-US')} remaining)`
      );
    }
    return result.join('\n');
  }

  private async getSequenceMetrics(): Promise<SequenceMetrics[]> {
    // First get all sequences used as default values
    const sequenceRows = await queryRows(
      this.sqlDriver,
      `
            SELECT
                c.relname AS table,
                attname AS column,
                format_type(a.atttypid, a.atttypmod) AS column_type,
                pg_get_expr(d.adbin, d.adrelid) AS default_value
            FROM
                pg_catalog.pg_attribute a
            INNER JOIN
                pg_catalog.pg_class c ON c.oid = a.attrelid
            INNER JOIN
                pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            INNER JOIN
                pg_catalog.pg_attrdef d ON (a.attrelid, a.attnum) = (d.adrelid, d.adnum)
            WHERE
                NOT a.attisdropped
                AND a.attnum > 0
                AND pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval%'
                AND n.nspname NOT LIKE 'pg\\_temp\\_%'
        `
    );

    const sequenceMetrics: SequenceMetrics[] = [];
    for (const seq of sequenceRows.map(toSequenceColumn)) {
      // Parse the sequence name from default value
      const [schema, sequence] = SequenceHealthCalc.parseSequenceName(seq.defaultValue);
      if (!sequence) {
        continue;
      }

      // Determine max value based on column type
      const maxValue = maxValueFor(seq.columnType);

      // Get sequence attributes
      const attrs = await SafeSqlDriver.executeParamQuery(
        this.sqlDriver,
        `
                SELECT
                    has_sequence_privilege('{}', 'SELECT') AS readable,
                    last_value
                FROM {}
                `,
        [identifier(schema, sequence), identifier(schema, sequence)]
      );

      const { lastValue, readable } = toSequenceAttributes(cell.single(attrs));
      sequenceMetrics.push({
        schema,
        table: seq.table,
        column: seq.column,
        sequence,
        columnType: seq.columnType,
        lastValue,
        maxValue,
        readable,
        isHealthy: Number(lastValue) / Number(maxValue) <= this.threshold,
      });
    }

    return sequenceMetrics;
  }
}
