import type { SqlExecutor } from '../sql/safe-sql.ts';
import { SafeSqlDriver } from '../sql/safe-sql.ts';

interface IndexInfo {
  columns: string[];
  indexprs: string | null;
  indpred: string | null;
  name: string;
  primary: boolean;
  schema: string;
  table: string;
  unique: boolean;
  using: string;
  valid: boolean;
}

interface DuplicateIndex {
  coveringIndex: IndexInfo;
  unneededIndex: IndexInfo;
}

const BYTES_PER_MB = 1024 * 1024;
const QUOTES_AT_ENDS = /^"+|"+$/gu;

function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

function compareLists(a: readonly string[], b: readonly string[]): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    const order = compareStrings(a[i] ?? '', b[i] ?? '');
    if (order !== 0) {
      return order;
    }
  }
  return a.length - b.length;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function nullableText(value: unknown): string | null {
  // oxlint-disable-next-line typescript/no-base-to-string -- stringified like upstream's str(); objects and arrays diverge, see docs/TODO.md
  return value === null || value === undefined ? null : String(value);
}

/** Whether the columns of an index start with all of `columns`. */
function indexCovers(indexedColumns: readonly string[], columns: readonly string[]): boolean {
  return sameList(indexedColumns.slice(0, columns.length), columns);
}

function coversAsDuplicate(covering: IndexInfo, index: IndexInfo): boolean {
  const covers =
    covering.valid &&
    covering.name !== index.name &&
    indexCovers(covering.columns, index.columns) &&
    covering.using === index.using &&
    covering.indexprs === index.indexprs &&
    covering.indpred === index.indpred;
  if (!covers) {
    return false;
  }
  return (
    !sameList(covering.columns, index.columns) || index.name > covering.name || covering.primary || covering.unique
  );
}

function toMb(bytes: unknown): number {
  return Math.trunc(Number(bytes)) / BYTES_PER_MB;
}

export class IndexHealthCalc {
  private cachedIndexes: IndexInfo[] | null = null;
  private readonly sqlDriver: SqlExecutor;

  constructor(sqlDriver: SqlExecutor) {
    this.sqlDriver = sqlDriver;
  }

  async invalidIndexCheck(): Promise<string> {
    const indexes = await this.indexes();
    // Check for invalid indexes being created
    const invalidIndexes = indexes.filter((idx) => !idx.valid);
    if (invalidIndexes.length === 0) {
      return 'No invalid indexes found.';
    }

    return `Invalid indexes found: ${invalidIndexes
      .map((idx) => `${idx.name} on ${idx.table} is invalid.`)
      .join('\n')}`;
  }

  async duplicateIndexCheck(): Promise<string> {
    const indexes = await this.indexes();
    const dupIndexes: DuplicateIndex[] = [];

    // Group indexes by schema and table
    const indexesByTable = new Map<string, IndexInfo[]>();
    for (const idx of indexes) {
      const key = JSON.stringify([idx.schema, idx.table]);
      const group = indexesByTable.get(key);
      if (group) {
        group.push(idx);
      } else {
        indexesByTable.set(key, [idx]);
      }
    }

    // Check each valid non-primary/unique index for duplicates
    for (const index of indexes.filter((i) => i.valid && !i.primary && !i.unique)) {
      const tableIndexes = indexesByTable.get(JSON.stringify([index.schema, index.table])) ?? [];
      const coveringIndex = tableIndexes.find((covering) => coversAsDuplicate(covering, index));
      if (coveringIndex) {
        dupIndexes.push({ unneededIndex: index, coveringIndex });
      }
    }

    if (dupIndexes.length === 0) {
      return 'No duplicate indexes found.';
    }

    // Sort by table and columns and format the output
    const sortedDups = dupIndexes.toSorted(
      (a, b) =>
        compareStrings(a.unneededIndex.table, b.unneededIndex.table) ||
        compareLists(a.unneededIndex.columns, b.unneededIndex.columns)
    );

    const result = ['Duplicate indexes found:'];
    for (const dup of sortedDups) {
      result.push(
        `Index '${dup.unneededIndex.name}' on table '${dup.unneededIndex.table}' ` +
          `is covered by index '${dup.coveringIndex.name}'`
      );
    }

    return result.join('\n');
  }

  /** Check for bloated indexes that are larger than `minSize` bytes (default 100MB). */
  async indexBloat(minSize = 104_857_600): Promise<string> {
    const bloatedIndexes = await SafeSqlDriver.executeParamQuery(
      this.sqlDriver,
      `
            WITH btree_index_atts AS (
                SELECT
                    nspname, relname, reltuples, relpages, indrelid, relam,
                    regexp_split_to_table(indkey::text, ' ')::smallint AS attnum,
                    indexrelid as index_oid
                FROM
                    pg_index
                JOIN
                    pg_class ON pg_class.oid = pg_index.indexrelid
                JOIN
                    pg_namespace ON pg_namespace.oid = pg_class.relnamespace
                JOIN
                    pg_am ON pg_class.relam = pg_am.oid
                WHERE
                    pg_am.amname = 'btree'
            ),
            index_item_sizes AS (
                SELECT
                    i.nspname,
                    i.relname,
                    i.reltuples,
                    i.relpages,
                    i.relam,
                    (quote_ident(s.schemaname) || '.' || quote_ident(s.tablename))::regclass AS starelid,
                    a.attrelid AS table_oid, index_oid,
                    current_setting('block_size')::numeric AS bs,
                    CASE
                        WHEN version() ~ 'mingw32' OR version() ~ '64-bit' THEN 8
                        ELSE 4
                    END AS maxalign,
                    24 AS pagehdr,
                    CASE WHEN max(coalesce(s.null_frac,0)) = 0
                        THEN 2
                        ELSE 6
                    END AS index_tuple_hdr,
                    sum( (1-coalesce(s.null_frac, 0)) * coalesce(s.avg_width, 2048) ) AS nulldatawidth
                FROM
                    pg_attribute AS a
                JOIN
                    pg_stats AS s ON (quote_ident(s.schemaname) || '.' || quote_ident(s.tablename))::regclass=a.attrelid AND s.attname = a.attname
                JOIN
                    btree_index_atts AS i ON i.indrelid = a.attrelid AND a.attnum = i.attnum
                WHERE
                    a.attnum > 0
                GROUP BY
                    1, 2, 3, 4, 5, 6, 7, 8, 9
            ),
            index_aligned AS (
                SELECT
                    maxalign,
                    bs,
                    nspname,
                    relname AS index_name,
                    reltuples,
                    relpages,
                    relam,
                    table_oid,
                    index_oid,
                    ( 2 +
                        maxalign - CASE
                            WHEN index_tuple_hdr%maxalign = 0 THEN maxalign
                            ELSE index_tuple_hdr%maxalign
                        END
                    + nulldatawidth + maxalign - CASE
                            WHEN nulldatawidth::integer%maxalign = 0 THEN maxalign
                            ELSE nulldatawidth::integer%maxalign
                        END
                    )::numeric AS nulldatahdrwidth, pagehdr
                FROM
                    index_item_sizes AS s1
            ),
            otta_calc AS (
                SELECT
                    bs,
                    nspname,
                    table_oid,
                    index_oid,
                    index_name,
                    relpages,
                    coalesce(
                        ceil((reltuples*(4+nulldatahdrwidth))/(bs-pagehdr::float)) +
                        CASE WHEN am.amname IN ('hash','btree') THEN 1 ELSE 0 END , 0
                    ) AS otta
                FROM
                    index_aligned AS s2
                LEFT JOIN
                    pg_am am ON s2.relam = am.oid
            ),
            raw_bloat AS (
                SELECT
                    nspname,
                    c.relname AS table_name,
                    index_name,
                    bs*(sub.relpages)::bigint AS totalbytes,
                    CASE
                        WHEN sub.relpages <= otta THEN 0
                        ELSE bs*(sub.relpages-otta)::bigint END
                        AS wastedbytes,
                    CASE
                        WHEN sub.relpages <= otta
                        THEN 0 ELSE bs*(sub.relpages-otta)::bigint * 100 / (bs*(sub.relpages)::bigint) END
                        AS realbloat,
                    pg_relation_size(sub.table_oid) as table_bytes,
                    stat.idx_scan as index_scans,
                    stat.indexrelid
                FROM
                    otta_calc AS sub
                JOIN
                    pg_class AS c ON c.oid=sub.table_oid
                JOIN
                    pg_stat_user_indexes AS stat ON sub.index_oid = stat.indexrelid
            )
            SELECT
                nspname AS schema,
                table_name AS table,
                index_name AS index,
                wastedbytes AS bloat_bytes,
                totalbytes AS index_bytes,
                pg_get_indexdef(rb.indexrelid) AS definition,
                indisprimary AS primary
            FROM
                raw_bloat rb
            INNER JOIN
                pg_index i ON i.indexrelid = rb.indexrelid
            WHERE
                wastedbytes >= {}
            ORDER BY
                wastedbytes DESC,
                index_name
        `,
      [minSize]
    );

    if (!bloatedIndexes || bloatedIndexes.length === 0) {
      return 'No bloated indexes found.';
    }

    const result = ['Bloated indexes found:'];
    for (const { cells } of bloatedIndexes) {
      const bloatMb = toMb(cells.bloat_bytes);
      const totalMb = toMb(cells.index_bytes);
      result.push(
        `Index '${String(cells.index)}' on table '${String(cells.table)}' has ${bloatMb.toFixed(1)}MB bloat out of ${totalMb.toFixed(1)}MB total size`
      );
    }

    return result.join('\n');
  }

  private async indexes(): Promise<IndexInfo[]> {
    if (this.cachedIndexes && this.cachedIndexes.length > 0) {
      return this.cachedIndexes;
    }

    // Get index information
    const results = await this.sqlDriver.executeQuery(`
            SELECT
                schemaname AS schema,
                t.relname AS table,
                ix.relname AS name,
                regexp_replace(pg_get_indexdef(i.indexrelid), '^[^\\(]*\\((.*)\\)$', '\\1') AS columns,
                regexp_replace(pg_get_indexdef(i.indexrelid), '.* USING ([^ ]*) \\(.*', '\\1') AS using,
                indisunique AS unique,
                indisprimary AS primary,
                indisvalid AS valid,
                indexprs::text,
                indpred::text,
                pg_get_indexdef(i.indexrelid) AS definition
            FROM
                pg_index i
            INNER JOIN
                pg_class t ON t.oid = i.indrelid
            INNER JOIN
                pg_class ix ON ix.oid = i.indexrelid
            LEFT JOIN
                pg_stat_user_indexes ui ON ui.indexrelid = i.indexrelid
            WHERE
                schemaname IS NOT NULL
            ORDER BY
                1, 2
        `);

    if (results === null) {
      return [];
    }

    const indexes = results.map(({ cells }): IndexInfo => {
      // Unquote column names
      const columns = String(cells.columns)
        .replace(') WHERE (', ' WHERE ')
        .split(', ')
        .map((col) => col.replaceAll(QUOTES_AT_ENDS, ''));
      return {
        schema: String(cells.schema),
        table: String(cells.table),
        name: String(cells.name),
        columns,
        using: String(cells.using),
        unique: Boolean(cells.unique),
        primary: Boolean(cells.primary),
        valid: Boolean(cells.valid),
        indexprs: nullableText(cells.indexprs),
        indpred: nullableText(cells.indpred),
      };
    });

    this.cachedIndexes = indexes;
    return indexes;
  }

  /** Check for unused or rarely used indexes (at most `maxScans` scans, default 50). */
  async unusedIndexes(maxScans = 50): Promise<string> {
    const unused = await SafeSqlDriver.executeParamQuery(
      this.sqlDriver,
      `
            SELECT
                schemaname AS schema,
                relname AS table,
                indexrelname AS index,
                pg_relation_size(i.indexrelid) AS size_bytes,
                idx_scan as index_scans,
                pg_get_indexdef(i.indexrelid) AS definition,
                indisprimary AS primary
            FROM
                pg_stat_user_indexes ui
            INNER JOIN
                pg_index i ON ui.indexrelid = i.indexrelid
            WHERE
                NOT indisunique
                AND idx_scan <= {}
            ORDER BY
                pg_relation_size(i.indexrelid) DESC,
                relname ASC
        `,
      [maxScans]
    );

    if (!unused || unused.length === 0) {
      return 'No unused indexes found.';
    }

    const result = ['Rarely used indexes found:'];
    for (const { cells } of unused) {
      if (cells.primary) {
        continue;
      }
      const sizeMb = toMb(cells.size_bytes);
      result.push(
        `Index '${String(cells.index)}' on table '${String(cells.table)}' has only been scanned ${String(cells.index_scans)} times and uses ${sizeMb.toFixed(1)}MB of space`
      );
    }

    return result.join('\n');
  }
}
