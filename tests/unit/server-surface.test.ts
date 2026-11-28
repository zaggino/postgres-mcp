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
  outputSchema?: true;
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
    outputSchema: true,
    params: ['database', 'max_index_size_mb', 'method'],
    required: ['database'],
    defaults: { max_index_size_mb: 10_000, method: 'dta' },
    annotations: { title: 'Analyze Workload Indexes', readOnlyHint: true },
  },
  {
    name: 'analyze_query_indexes',
    outputSchema: true,
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
    required: ['database', 'sql'],
    defaults: {},
    annotations: { title: 'Execute SQL', destructiveHint: true },
  },
  {
    name: 'list_databases',
    params: [],
    required: [],
    defaults: {},
    annotations: { title: 'List Databases', readOnlyHint: true },
  },
  {
    name: 'cancel_query',
    params: ['call_id'],
    required: [],
    defaults: {},
    annotations: { title: 'Cancel Query', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
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

test('unrestricted mode lists the eleven tools in upstream order with their parameters and annotations', async () => {
  const client = await connectClient(createServer(createTestRegistry(['app']).registry));

  const { tools } = await client.listTools();

  expect(
    tools.map((tool) => ({
      name: tool.name,
      params: Object.keys(tool.inputSchema.properties ?? {}),
      required: tool.inputSchema.required ?? [],
      defaults: schemaDefaults(tool.inputSchema.properties),
      annotations: tool.annotations,
      ...(tool.outputSchema && { outputSchema: true }),
    }))
  ).toEqual(EXPECTED_TOOLS);
});

test('execute_sql without sql is rejected without querying the database', async () => {
  const { registry, fakes } = createTestRegistry(['app']);
  const client = await connectClient(createServer(registry));

  const result = await client.callTool({ name: 'execute_sql', arguments: { database: 'app' } });

  expect(result.isError).toBe(true);
  expect(fakes.get('app')?.queries ?? []).toEqual([]);
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

test('restricted mode does not offer cancel_query', async () => {
  const client = await connectClient(
    createServer(createTestRegistry(['app'], { accessMode: AccessMode.RESTRICTED }).registry)
  );

  const { tools } = await client.listTools();

  expect(tools.map((tool) => tool.name)).not.toContain('cancel_query');
});

/** Property names and required lists of a JSON schema object, recursively through objects and arrays. */
function schemaOutline(schema: unknown): unknown {
  if (typeof schema !== 'object' || schema === null) {
    return null;
  }
  const node = schema as { items?: unknown; properties?: Record<string, unknown>; required?: string[] };
  if (node.items) {
    return [schemaOutline(node.items)];
  }
  if (!node.properties) {
    return null;
  }
  return {
    required: node.required ?? [],
    properties: Object.fromEntries(
      Object.entries(node.properties).map(([name, value]) => [name, schemaOutline(value)])
    ),
  };
}

const COST_BENEFIT_OUTLINE = {
  required: ['base_cost', 'new_cost', 'improvement_multiple'],
  properties: { base_cost: null, new_cost: null, improvement_multiple: null },
};

test('the index advisor tools publish the same output schema with these fields', async () => {
  const client = await connectClient(createServer(createTestRegistry(['app']).registry));

  const { tools } = await client.listTools();
  const outlines = ['analyze_workload_indexes', 'analyze_query_indexes'].map((name) =>
    schemaOutline(tools.find((tool) => tool.name === name)?.outputSchema)
  );

  expect(outlines).toEqual([outlines[0], outlines[0]]);
  expect(outlines[0]).toEqual({
    required: ['summary', 'recommendations', 'query_impact'],
    properties: {
      summary: {
        required: ['total_recommendations', ...COST_BENEFIT_OUTLINE.required, 'total_size_bytes'],
        properties: { total_recommendations: null, ...COST_BENEFIT_OUTLINE.properties, total_size_bytes: null },
      },
      recommendations: [
        {
          required: [
            'index_apply_order',
            'index_target_table',
            'index_target_columns',
            'benefit_of_this_index_only',
            'benefit_after_previous_indexes',
            'index_size_bytes',
            'index_definition',
          ],
          properties: {
            index_apply_order: null,
            index_target_table: null,
            index_target_columns: [null],
            benefit_of_this_index_only: COST_BENEFIT_OUTLINE,
            benefit_after_previous_indexes: COST_BENEFIT_OUTLINE,
            index_size_bytes: null,
            index_definition: null,
            warning: null,
          },
        },
      ],
      query_impact: [
        {
          required: [
            'query',
            ...COST_BENEFIT_OUTLINE.required,
            'before_explain_plan',
            'after_explain_plan',
            'explain_plan_diff',
          ],
          properties: {
            query: null,
            ...COST_BENEFIT_OUTLINE.properties,
            before_explain_plan: null,
            after_explain_plan: null,
            explain_plan_diff: null,
          },
        },
      ],
    },
  });
});
