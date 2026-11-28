import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import * as cell from '../sql/cells.ts';
import type { SqlExecutor } from '../sql/safe-sql.ts';
import { SafeSqlDriver, queryRows } from '../sql/safe-sql.ts';
import type { Row } from '../sql/sql-driver.ts';
import { formatError, formatTextResponse, toJson } from './result.ts';

export async function listSchemas(sqlDriver: SqlExecutor): Promise<CallToolResult> {
  const rows = await queryRows(
    sqlDriver,
    `
            SELECT
                schema_name,
                schema_owner,
                CASE
                    WHEN schema_name LIKE 'pg_%' THEN 'System Schema'
                    WHEN schema_name = 'information_schema' THEN 'System Information Schema'
                    ELSE 'User Schema'
                END as schema_type
            FROM information_schema.schemata
            ORDER BY schema_type, schema_name
            `
  );
  const schemas = rows.map((row) => ({
    schema_name: cell.text(row, 'schema_name'),
    schema_owner: cell.text(row, 'schema_owner'),
    schema_type: cell.text(row, 'schema_type'),
  }));
  return formatTextResponse(toJson(schemas));
}

interface TableSummary {
  schema: string;
  name: string;
  type: string;
}

interface SequenceSummary {
  schema: string;
  name: string;
  data_type: string;
}

interface SequenceDetails extends SequenceSummary {
  start_value: string;
  increment: string;
}

interface ExtensionInfo {
  name: string;
  version: string;
  relocatable: boolean;
}

const toTableSummary = (row: Row): TableSummary => ({
  schema: cell.text(row, 'table_schema'),
  name: cell.text(row, 'table_name'),
  type: cell.text(row, 'table_type'),
});

const toSequenceSummary = (row: Row): SequenceSummary => ({
  schema: cell.text(row, 'sequence_schema'),
  name: cell.text(row, 'sequence_name'),
  data_type: cell.text(row, 'data_type'),
});

const toSequenceDetails = (row: Row): SequenceDetails => ({
  ...toSequenceSummary(row),
  start_value: cell.text(row, 'start_value'),
  increment: cell.text(row, 'increment'),
});

const toExtensionInfo = (row: Row): ExtensionInfo => ({
  name: cell.text(row, 'extname'),
  version: cell.text(row, 'extversion'),
  relocatable: cell.boolean(row, 'extrelocatable'),
});

interface ObjectKind {
  list: (sqlDriver: SqlExecutor, schemaName: string) => Promise<unknown>;
  details: (sqlDriver: SqlExecutor, schemaName: string, objectName: string) => Promise<unknown>;
}

/** Tables and views differ only in the information_schema `table_type` and the `type` label. */
function tableKind(objectType: 'table' | 'view', tableType: string): ObjectKind {
  return {
    async list(sqlDriver, schemaName) {
      const rows = await SafeSqlDriver.executeParamQuery(
        sqlDriver,
        `
                SELECT table_schema, table_name, table_type
                FROM information_schema.tables
                WHERE table_schema = {} AND table_type = {}
                ORDER BY table_name
                `,
        [schemaName, tableType]
      );
      return rows.map(toTableSummary);
    },
    details: (sqlDriver, schemaName, objectName) => tableDetails(sqlDriver, schemaName, objectName, objectType),
  };
}

const sequenceKind: ObjectKind = {
  async list(sqlDriver, schemaName) {
    const rows = await SafeSqlDriver.executeParamQuery(
      sqlDriver,
      `
                SELECT sequence_schema, sequence_name, data_type
                FROM information_schema.sequences
                WHERE sequence_schema = {}
                ORDER BY sequence_name
                `,
      [schemaName]
    );
    return rows.map(toSequenceSummary);
  },
  async details(sqlDriver, schemaName, objectName) {
    const rows = await SafeSqlDriver.executeParamQuery(
      sqlDriver,
      `
                SELECT sequence_schema, sequence_name, data_type, start_value, increment
                FROM information_schema.sequences
                WHERE sequence_schema = {} AND sequence_name = {}
                `,
      [schemaName, objectName]
    );
    const [row] = rows;
    return row ? toSequenceDetails(row) : {};
  },
};

const extensionKind: ObjectKind = {
  // Extensions are not schema-specific
  async list(sqlDriver) {
    const rows = await queryRows(
      sqlDriver,
      `
                SELECT extname, extversion, extrelocatable
                FROM pg_extension
                ORDER BY extname
                `
    );
    return rows.map(toExtensionInfo);
  },
  async details(sqlDriver, _schemaName, objectName) {
    const rows = await SafeSqlDriver.executeParamQuery(
      sqlDriver,
      `
                SELECT extname, extversion, extrelocatable
                FROM pg_extension
                WHERE extname = {}
                `,
      [objectName]
    );
    const [row] = rows;
    return row ? toExtensionInfo(row) : {};
  },
};

const objectKinds: Record<string, ObjectKind> = {
  table: tableKind('table', 'BASE TABLE'),
  view: tableKind('view', 'VIEW'),
  sequence: sequenceKind,
  extension: extensionKind,
};

/** Runs `run` for a supported object type; an unknown type is a tool error. */
async function withObjectKind(
  objectType: string,
  run: (kind: ObjectKind) => Promise<unknown>
): Promise<CallToolResult> {
  const kind = Object.hasOwn(objectKinds, objectType) ? objectKinds[objectType] : undefined;
  if (!kind) {
    return formatError(`Unsupported object type: ${objectType}`);
  }
  return formatTextResponse(toJson(await run(kind)));
}

export async function listObjects(
  sqlDriver: SqlExecutor,
  schemaName: string,
  objectType: string
): Promise<CallToolResult> {
  return await withObjectKind(objectType, (kind) => kind.list(sqlDriver, schemaName));
}

async function tableDetails(
  sqlDriver: SqlExecutor,
  schemaName: string,
  objectName: string,
  objectType: 'table' | 'view'
): Promise<unknown> {
  const colRows = await SafeSqlDriver.executeParamQuery(
    sqlDriver,
    `
                SELECT column_name, data_type, is_nullable, column_default
                FROM information_schema.columns
                WHERE table_schema = {} AND table_name = {}
                ORDER BY ordinal_position
                `,
    [schemaName, objectName]
  );
  const columns = colRows.map((r) => ({
    column: cell.text(r, 'column_name'),
    data_type: cell.text(r, 'data_type'),
    is_nullable: cell.text(r, 'is_nullable'),
    default: cell.nullableText(r, 'column_default'),
  }));

  const conRows = await SafeSqlDriver.executeParamQuery(
    sqlDriver,
    `
                SELECT tc.constraint_name, tc.constraint_type, kcu.column_name
                FROM information_schema.table_constraints AS tc
                LEFT JOIN information_schema.key_column_usage AS kcu
                  ON tc.constraint_name = kcu.constraint_name
                 AND tc.table_schema = kcu.table_schema
                WHERE tc.table_schema = {} AND tc.table_name = {}
                `,
    [schemaName, objectName]
  );

  const constraints = new Map<string, { name: string; type: string; columns: string[] }>();
  for (const row of conRows) {
    const name = cell.text(row, 'constraint_name');
    const col = cell.nullableText(row, 'column_name');
    let constraint = constraints.get(name);
    if (!constraint) {
      constraint = { name, type: cell.text(row, 'constraint_type'), columns: [] };
      constraints.set(name, constraint);
    }
    if (col) {
      constraint.columns.push(col);
    }
  }

  const idxRows = await SafeSqlDriver.executeParamQuery(
    sqlDriver,
    `
                SELECT indexname, indexdef
                FROM pg_indexes
                WHERE schemaname = {} AND tablename = {}
                `,
    [schemaName, objectName]
  );
  const indexes = idxRows.map((r) => ({
    name: cell.text(r, 'indexname'),
    definition: cell.text(r, 'indexdef'),
  }));

  return {
    basic: { schema: schemaName, name: objectName, type: objectType },
    columns,
    constraints: [...constraints.values()],
    indexes,
  };
}

export async function getObjectDetails(
  sqlDriver: SqlExecutor,
  schemaName: string,
  objectName: string,
  objectType: string
): Promise<CallToolResult> {
  return await withObjectKind(objectType, (kind) => kind.details(sqlDriver, schemaName, objectName));
}
