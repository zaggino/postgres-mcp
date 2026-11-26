import { afterEach, expect, it as test, vi } from 'vitest';

import { createServer } from '../../src/server.ts';
import { AccessMode } from '../../src/sql/driver-factory.ts';
import { callToolText, connectClient } from '../support/mcp-client.ts';
import { createTestRegistry } from '../support/registry.ts';

const ERROR_TEXT = /^Error:/u;

afterEach(() => {
  vi.restoreAllMocks();
});

interface ExpectedTool {
  annotations: Record<string, unknown>;
  defaults: Record<string, unknown>;
  name: string;
  params: string[];
  required: string[];
}

const EXPECTED_TOOLS: ExpectedTool[] = [
  {
    name: 'list_schemas',
    params: ['database'],
    required: ['database'],
    defaults: {},
    annotations: { title: 'List Schemas', readOnlyHint: true },
  },
  {
    name: 'list_objects',
    params: ['database', 'schema_name', 'object_type'],
    required: ['database', 'schema_name'],
    defaults: { object_type: 'table' },
    annotations: { title: 'List Objects', readOnlyHint: true },
  },
  {
    name: 'get_object_details',
    params: ['database', 'schema_name', 'object_name', 'object_type'],
    required: ['database', 'schema_name', 'object_name'],
    defaults: { object_type: 'table' },
    annotations: { title: 'Get Object Details', readOnlyHint: true },
  },
  {
    name: 'explain_query',
    params: ['database', 'sql', 'analyze', 'hypothetical_indexes'],
    required: ['database', 'sql'],
    defaults: { analyze: false, hypothetical_indexes: [] },
    annotations: { title: 'Explain Query', readOnlyHint: true },
  },
  {
    name: 'analyze_workload_indexes',
    params: ['database', 'max_index_size_mb', 'method'],
    required: ['database'],
    defaults: { max_index_size_mb: 10_000, method: 'dta' },
    annotations: { title: 'Analyze Workload Indexes', readOnlyHint: true },
  },
  {
    name: 'analyze_query_indexes',
    params: ['database', 'queries', 'max_index_size_mb', 'method'],
    required: ['database', 'queries'],
    defaults: { max_index_size_mb: 10_000, method: 'dta' },
    annotations: { title: 'Analyze Query Indexes', readOnlyHint: true },
  },
  {
    name: 'analyze_db_health',
    params: ['database', 'health_type'],
    required: ['database'],
    defaults: { health_type: 'all' },
    annotations: { title: 'Analyze Database Health', readOnlyHint: true },
  },
  {
    name: 'get_top_queries',
    params: ['database', 'sort_by', 'limit'],
    required: ['database'],
    defaults: { sort_by: 'resources', limit: 10 },
    annotations: { title: 'Get Top Queries', readOnlyHint: true },
  },
  {
    name: 'execute_sql',
    params: ['database', 'sql'],
    required: ['database'],
    defaults: { sql: 'all' },
    annotations: { title: 'Execute SQL', destructiveHint: true },
  },
  {
    name: 'list_databases',
    params: [],
    required: [],
    defaults: {},
    annotations: { title: 'List Databases', readOnlyHint: true },
  },
];

function schemaDefaults(properties: Record<string, unknown> | undefined): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(properties ?? {})) {
    if (typeof property === 'object' && property && 'default' in property) {
      defaults[name] = property.default;
    }
  }
  return defaults;
}

test('unrestricted mode lists the ten tools in upstream order with their parameters and annotations', async () => {
  const client = await connectClient(createServer(createTestRegistry(['app']).registry));

  const { tools } = await client.listTools();

  expect(
    tools.map((tool) => ({
      name: tool.name,
      params: Object.keys(tool.inputSchema.properties ?? {}),
      required: tool.inputSchema.required ?? [],
      defaults: schemaDefaults(tool.inputSchema.properties),
      annotations: tool.annotations,
    }))
  ).toEqual(EXPECTED_TOOLS);
});

test('restricted mode rejects a DROP TABLE through execute_sql without sending it to the database', async () => {
  const { registry, fakes } = createTestRegistry(['app'], { accessMode: AccessMode.RESTRICTED });
  const client = await connectClient(createServer(registry));

  const text = await callToolText(client, 'execute_sql', {
    database: 'app',
    sql: 'DROP TABLE x',
  });

  expect(text).toMatch(ERROR_TEXT);
  expect((fakes.get('app')?.queries ?? []).map((query) => query.text)).not.toContainEqual(
    expect.stringContaining('DROP TABLE')
  );
});
