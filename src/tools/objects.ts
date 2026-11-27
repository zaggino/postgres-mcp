import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { SqlExecutor } from '../sql/safe-sql.ts';
import { SafeSqlDriver } from '../sql/safe-sql.ts';
import { formatError, formatTextResponse, toJson } from './result.ts';

function cell(row: { cells: Record<string, unknown> }, name: string): unknown {
  return row.cells[name];
}

export async function listSchemas(sqlDriver: SqlExecutor): Promise<CallToolResult> {
  const rows = await sqlDriver.executeQuery(
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
  const schemas = rows ? rows.map((row) => row.cells) : [];
  return formatTextResponse(toJson(schemas));
}

export async function listObjects(
  sqlDriver: SqlExecutor,
  schemaName: string,
  objectType: string
): Promise<CallToolResult> {
  let objects: unknown[];

  if (objectType === 'table' || objectType === 'view') {
    const tableType = objectType === 'table' ? 'BASE TABLE' : 'VIEW';
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
    objects = rows
      ? rows.map((row) => ({
          schema: cell(row, 'table_schema'),
          name: cell(row, 'table_name'),
          type: cell(row, 'table_type'),
        }))
      : [];
  } else if (objectType === 'sequence') {
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
    objects = rows
      ? rows.map((row) => ({
          schema: cell(row, 'sequence_schema'),
          name: cell(row, 'sequence_name'),
          data_type: cell(row, 'data_type'),
        }))
      : [];
  } else if (objectType === 'extension') {
    // Extensions are not schema-specific
    const rows = await sqlDriver.executeQuery(
      `
                SELECT extname, extversion, extrelocatable
                FROM pg_extension
                ORDER BY extname
                `
    );
    objects = rows
      ? rows.map((row) => ({
          name: cell(row, 'extname'),
          version: cell(row, 'extversion'),
          relocatable: cell(row, 'extrelocatable'),
        }))
      : [];
  } else {
    return formatError(`Unsupported object type: ${objectType}`);
  }

  return formatTextResponse(toJson(objects));
}

async function tableDetails(
  sqlDriver: SqlExecutor,
  schemaName: string,
  objectName: string,
  objectType: string
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
  const columns = colRows
    ? colRows.map((r) => ({
        column: cell(r, 'column_name'),
        data_type: cell(r, 'data_type'),
        is_nullable: cell(r, 'is_nullable'),
        default: cell(r, 'column_default'),
      }))
    : [];

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

  const constraints = new Map<unknown, { name: unknown; type: unknown; columns: unknown[] }>();
  for (const row of conRows ?? []) {
    const name = cell(row, 'constraint_name');
    const col = cell(row, 'column_name');
    let constraint = constraints.get(name);
    if (!constraint) {
      constraint = { name, type: cell(row, 'constraint_type'), columns: [] };
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
  const indexes = idxRows
    ? idxRows.map((r) => ({
        name: cell(r, 'indexname'),
        definition: cell(r, 'indexdef'),
      }))
    : [];

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
  let result: unknown;

  if (objectType === 'table' || objectType === 'view') {
    result = await tableDetails(sqlDriver, schemaName, objectName, objectType);
  } else if (objectType === 'sequence') {
    const rows = await SafeSqlDriver.executeParamQuery(
      sqlDriver,
      `
                SELECT sequence_schema, sequence_name, data_type, start_value, increment
                FROM information_schema.sequences
                WHERE sequence_schema = {} AND sequence_name = {}
                `,
      [schemaName, objectName]
    );
    const row = rows?.[0];
    result = row
      ? {
          schema: cell(row, 'sequence_schema'),
          name: cell(row, 'sequence_name'),
          data_type: cell(row, 'data_type'),
          start_value: cell(row, 'start_value'),
          increment: cell(row, 'increment'),
        }
      : {};
  } else if (objectType === 'extension') {
    const rows = await SafeSqlDriver.executeParamQuery(
      sqlDriver,
      `
                SELECT extname, extversion, extrelocatable
                FROM pg_extension
                WHERE extname = {}
                `,
      [objectName]
    );
    const row = rows?.[0];
    result = row
      ? {
          name: cell(row, 'extname'),
          version: cell(row, 'extversion'),
          relocatable: cell(row, 'extrelocatable'),
        }
      : {};
  } else {
    return formatError(`Unsupported object type: ${objectType}`);
  }

  return formatTextResponse(toJson(result));
}
