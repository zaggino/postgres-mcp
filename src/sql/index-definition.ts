const CONSECUTIVE_UNDERSCORES = /_{2,}/gu;
const TRAILING_UNDERSCORES = /_+$/u;

/** Immutable index configuration. */
export class IndexDefinition {
  readonly table: string;
  readonly columns: readonly string[];
  readonly using: string;

  constructor(table: string, columns: readonly string[], using = 'btree') {
    this.table = table;
    this.columns = Object.freeze([...columns]);
    this.using = using;
    Object.freeze(this);
  }

  /** Stable value-equality key for use in Map/Set. */
  get key(): string {
    return JSON.stringify([this.table, this.columns, this.using]);
  }

  get definition(): string {
    return `CREATE INDEX ${this.name} ON ${this.table} USING ${this.using} (${this.columns.join(', ')})`;
  }

  get name(): string {
    // Functional expressions like LOWER(col) must yield a valid index name
    const cleanedColumns = this.columns.map((col) =>
      col
        .replaceAll('(', '_')
        .replaceAll(')', '_')
        .replaceAll(' ', '_')
        .replaceAll(',', '_')
        .replaceAll(CONSECUTIVE_UNDERSCORES, '_')
        .replace(TRAILING_UNDERSCORES, '')
    );
    const columnPart = cleanedColumns.join('_');
    const suffix = this.using === 'btree' ? '' : `_${this.using}`;
    return `postgres_mcp_idx_${this.table}_${columnPart}_${this.columns.length}${suffix}`;
  }

  toDict(): {
    table: string;
    columns: string[];
    using: string;
    definition: string;
  } {
    return {
      table: this.table,
      columns: [...this.columns],
      using: this.using,
      definition: this.definition,
    };
  }

  toString(): string {
    return this.definition;
  }
}
