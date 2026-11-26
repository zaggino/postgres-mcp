import { afterEach, expect, it as test, vi } from "vitest";
import { AccessMode, createServer, dbConnection } from "../../src/server.ts";
import { createFakePool } from "../support/fake-pool.ts";
import { callToolText, connectClient } from "../support/mcp-client.ts";

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
    name: "list_schemas",
    params: [],
    required: [],
    defaults: {},
    annotations: { title: "List Schemas", readOnlyHint: true },
  },
  {
    name: "list_objects",
    params: ["schema_name", "object_type"],
    required: ["schema_name"],
    defaults: { object_type: "table" },
    annotations: { title: "List Objects", readOnlyHint: true },
  },
  {
    name: "get_object_details",
    params: ["schema_name", "object_name", "object_type"],
    required: ["schema_name", "object_name"],
    defaults: { object_type: "table" },
    annotations: { title: "Get Object Details", readOnlyHint: true },
  },
  {
    name: "explain_query",
    params: ["sql", "analyze", "hypothetical_indexes"],
    required: ["sql"],
    defaults: { analyze: false, hypothetical_indexes: [] },
    annotations: { title: "Explain Query", readOnlyHint: true },
  },
  {
    name: "analyze_workload_indexes",
    params: ["max_index_size_mb", "method"],
    required: [],
    defaults: { max_index_size_mb: 10_000, method: "dta" },
    annotations: { title: "Analyze Workload Indexes", readOnlyHint: true },
  },
  {
    name: "analyze_query_indexes",
    params: ["queries", "max_index_size_mb", "method"],
    required: ["queries"],
    defaults: { max_index_size_mb: 10_000, method: "dta" },
    annotations: { title: "Analyze Query Indexes", readOnlyHint: true },
  },
  {
    name: "analyze_db_health",
    params: ["health_type"],
    required: [],
    defaults: { health_type: "all" },
    annotations: { title: "Analyze Database Health", readOnlyHint: true },
  },
  {
    name: "get_top_queries",
    params: ["sort_by", "limit"],
    required: [],
    defaults: { sort_by: "resources", limit: 10 },
    annotations: { title: "Get Top Queries", readOnlyHint: true },
  },
  {
    name: "execute_sql",
    params: ["sql"],
    required: [],
    defaults: { sql: "all" },
    annotations: { title: "Execute SQL", destructiveHint: true },
  },
];

function schemaDefaults(
  properties: Record<string, unknown> | undefined
): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(properties ?? {})) {
    if (typeof property === "object" && property && "default" in property) {
      defaults[name] = property.default;
    }
  }
  return defaults;
}

test("unrestricted mode lists the nine tools in upstream order with their parameters and annotations", async () => {
  const client = await connectClient(createServer(AccessMode.UNRESTRICTED));

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

test("restricted mode rejects a DROP TABLE through execute_sql without sending it to the database", async () => {
  const fake = createFakePool();
  vi.spyOn(dbConnection, "poolConnect").mockResolvedValue(fake.pool);
  const client = await connectClient(createServer(AccessMode.RESTRICTED));

  const text = await callToolText(client, "execute_sql", {
    sql: "DROP TABLE x",
  });

  expect(text).toMatch(ERROR_TEXT);
  expect(fake.queries.map((query) => query.text)).not.toContainEqual(
    expect.stringContaining("DROP TABLE")
  );
});
