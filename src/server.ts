import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import packageJson from '../package.json' with { type: 'json' };
import { HEALTH_TYPES } from './database-health/database-health.ts';
import type { DatabaseRegistry } from './database-registry.ts';
import { errorMessage, UsageError } from './errors.ts';
import { advisorResultSchema } from './index/advisor-result.ts';
import { toJson } from './json.ts';
import { log } from './log.ts';
import { RunningCalls } from './running-calls.ts';
import { offersCancelQuery, serverInstructions } from './server-instructions.ts';
import { AccessMode } from './sql/driver-factory.ts';
import { PG_STAT_STATEMENTS } from './sql/extension-utils.ts';
import type { SqlExecutor } from './sql/safe-sql.ts';
import {
  analyzeDbHealth,
  analyzeQueryIndexes,
  analyzeWorkloadIndexes,
  executeSql,
  explainQuery,
  getTopQueries,
} from './tools/analysis.ts';
import { getObjectDetails, listObjects, listSchemas } from './tools/objects.ts';
import { formatError, formatTextResponse } from './tools/result.ts';

const SERVER_NAME = 'postgres-mcp';
const SERVER_VERSION = packageJson.version;

const HYPOTHETICAL_INDEXES_DESCRIPTION = `Hypothetical indexes to simulate, e.g. [{"table": "users", "columns": ["email"]}, {"table": "orders", "columns": ["user_id", "created_at"], "using": "btree"}]. Omit, or pass an empty list or null, for none.`;

const hypotheticalIndexSchema = z.strictObject({
  table: z.string().min(1).describe("Table to add the index to, e.g. 'users'"),
  columns: z
    .array(z.string().min(1))
    .min(1)
    .describe("Columns or expressions to index, in order, e.g. ['last_name', 'first_name'] or ['LOWER(email)']"),
  using: z.string().min(1).optional().describe("Index method, 'btree' by default (also 'hash', 'gist', ...)"),
});

const HEALTH_DESCRIPTION =
  'Analyzes database health. Here are the available health checks:\n' +
  '- index - checks for invalid, duplicate, and bloated indexes\n' +
  '- connection - checks the number of connection and their utilization\n' +
  '- vacuum - checks vacuum health for transaction id wraparound\n' +
  '- sequence - checks sequences at risk of exceeding their maximum value\n' +
  '- replication - checks replication health including lag and slots\n' +
  '- buffer - checks for buffer cache hit rates for indexes and tables\n' +
  '- constraint - checks for invalid constraints\n' +
  '- all - runs all checks\n' +
  "You can optionally specify a single health check or a comma-separated list of health checks. The default is 'all' checks.";

const databaseSchema = z.string().describe('Name of the database to run against (see list_databases)');

const objectTypeSchema = z
  .string()
  .default('table')
  .describe("Object type: 'table', 'view', 'sequence', or 'extension'");

const methodSchema = z.enum(['dta']).default('dta').describe('Method to use for analysis');

const maxIndexSizeSchema = z.number().int().default(10_000).describe('Max index size in MB');

/** Build an MCP server with every tool registered against the registry's databases and access mode. */
export function createServer(registry: DatabaseRegistry): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: serverInstructions(registry) }
  );

  // Per MCP session: createServer runs once per session.
  const calls = new RunningCalls();

  /**
   * Register a tool that runs against a named database: adds the required `database` argument, tracks the call for
   * cancel_query, and turns a failure into an `Error:` result (logged under `errorLog`, except a UsageError).
   */
  const registerDatabaseTool = <Shape extends z.ZodRawShape>(
    name: string,
    {
      errorLog,
      inputSchema,
      outputSchema,
      ...config
    }: {
      description: string;
      annotations: ToolAnnotations;
      errorLog: string;
      inputSchema: Shape;
      outputSchema?: z.ZodRawShape;
    },
    body: (sqlDriver: SqlExecutor, args: z.output<z.ZodObject<Shape>>) => Promise<CallToolResult>
  ): void => {
    server.registerTool<z.ZodRawShape, z.ZodRawShape>(
      name,
      { ...config, inputSchema: { database: databaseSchema, ...inputSchema }, ...(outputSchema && { outputSchema }) },
      async (validated, { signal }) => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the SDK has parsed the arguments against this inputSchema, but its callback type cannot follow a generic shape
        const args = validated as { database: string } & z.output<z.ZodObject<Shape>>;
        try {
          return await calls.track(name, args.database, signal, (callSignal) =>
            registry.use(args.database, (sqlDriver) => body(sqlDriver, args), { signal: callSignal })
          );
        } catch (error) {
          if (!(error instanceof UsageError)) {
            log('ERROR', `${errorLog}: ${errorMessage(error)}`);
          }
          // The SDK refuses a result with neither isError nor valid structuredContent, so every failure of a tool with an outputSchema is flagged.
          const result = formatError(error);
          return outputSchema ? { ...result, isError: true } : result;
        }
      }
    );
  };

  registerDatabaseTool(
    'list_schemas',
    {
      description: 'List all schemas in the database',
      inputSchema: {},
      annotations: { title: 'List Schemas', readOnlyHint: true },
      errorLog: 'Error listing schemas',
    },
    listSchemas
  );

  registerDatabaseTool(
    'list_objects',
    {
      description: 'List objects in a schema',
      inputSchema: {
        schema_name: z.string().describe('Schema name'),
        object_type: objectTypeSchema,
      },
      annotations: { title: 'List Objects', readOnlyHint: true },
      errorLog: 'Error listing objects',
    },
    (sqlDriver, { schema_name, object_type }) => listObjects(sqlDriver, schema_name, object_type)
  );

  registerDatabaseTool(
    'get_object_details',
    {
      description: 'Show detailed information about a database object',
      inputSchema: {
        schema_name: z.string().describe('Schema name'),
        object_name: z.string().describe('Object name'),
        object_type: objectTypeSchema,
      },
      annotations: { title: 'Get Object Details', readOnlyHint: true },
      errorLog: 'Error getting object details',
    },
    (sqlDriver, { schema_name, object_name, object_type }) =>
      getObjectDetails(sqlDriver, schema_name, object_name, object_type)
  );

  registerDatabaseTool(
    'explain_query',
    {
      description:
        'Explains the execution plan for a SQL query, showing how the database will execute it and provides detailed cost estimates.',
      inputSchema: {
        sql: z.string().describe('SQL query to explain'),
        analyze: z
          .boolean()
          .default(false)
          .describe(
            'When True, actually runs the query to show real execution statistics instead of estimates. ' +
              'Takes longer but provides more accurate information.'
          ),
        hypothetical_indexes: z
          .array(hypotheticalIndexSchema)
          .nullable()
          .default([])
          .describe(HYPOTHETICAL_INDEXES_DESCRIPTION),
      },
      annotations: { title: 'Explain Query', readOnlyHint: true },
      errorLog: 'Error explaining query',
    },
    (sqlDriver, { sql, analyze, hypothetical_indexes }) =>
      explainQuery(sqlDriver, sql, analyze, hypothetical_indexes ?? [])
  );

  registerDatabaseTool(
    'analyze_workload_indexes',
    {
      description: 'Analyze frequently executed queries in the database and recommend optimal indexes',
      inputSchema: {
        max_index_size_mb: maxIndexSizeSchema,
        method: methodSchema,
      },
      annotations: { title: 'Analyze Workload Indexes', readOnlyHint: true },
      outputSchema: advisorResultSchema.shape,
      errorLog: 'Error analyzing workload',
    },
    (sqlDriver, { max_index_size_mb }) => analyzeWorkloadIndexes(sqlDriver, max_index_size_mb)
  );

  registerDatabaseTool(
    'analyze_query_indexes',
    {
      description: 'Analyze a list of (up to 10) SQL queries and recommend optimal indexes',
      inputSchema: {
        queries: z.array(z.string()).describe('List of Query strings to analyze'),
        max_index_size_mb: maxIndexSizeSchema,
        method: methodSchema,
      },
      annotations: { title: 'Analyze Query Indexes', readOnlyHint: true },
      outputSchema: advisorResultSchema.shape,
      errorLog: 'Error analyzing queries',
    },
    (sqlDriver, { queries, max_index_size_mb }) => analyzeQueryIndexes(sqlDriver, queries, max_index_size_mb)
  );

  registerDatabaseTool(
    'analyze_db_health',
    {
      description: HEALTH_DESCRIPTION,
      inputSchema: {
        health_type: z
          .string()
          .default('all')
          .describe(`Optional. Valid values are: ${HEALTH_TYPES.toSorted().join(', ')}.`),
      },
      annotations: { title: 'Analyze Database Health', readOnlyHint: true },
      errorLog: 'Error analyzing database health',
    },
    (sqlDriver, { health_type }) => analyzeDbHealth(sqlDriver, health_type)
  );

  registerDatabaseTool(
    'get_top_queries',
    {
      description: `Reports the slowest or most resource-intensive queries using data from the '${PG_STAT_STATEMENTS}' extension.`,
      inputSchema: {
        sort_by: z
          .string()
          .default('resources')
          .describe(
            "Ranking criteria: 'total_time' for total execution time or 'mean_time' for mean execution time per call, or 'resources' " +
              'for resource-intensive queries'
          ),
        limit: z
          .number()
          .int()
          .default(10)
          .describe('Number of queries to return when ranking based on mean_time or total_time'),
      },
      annotations: { title: 'Get Top Queries', readOnlyHint: true },
      errorLog: 'Error getting slow queries',
    },
    (sqlDriver, { sort_by, limit }) => getTopQueries(sqlDriver, sort_by, limit)
  );

  // execute_sql is described according to the access mode
  const executeSqlConfig =
    registry.accessMode === AccessMode.UNRESTRICTED
      ? {
          description: 'Execute any SQL query',
          annotations: { title: 'Execute SQL', destructiveHint: true },
        }
      : {
          description: 'Execute a read-only SQL query',
          annotations: {
            title: 'Execute SQL (Read-Only)',
            readOnlyHint: true,
          },
        };
  registerDatabaseTool(
    'execute_sql',
    {
      ...executeSqlConfig,
      inputSchema: {
        sql: z.string().describe('SQL to run'),
      },
      errorLog: 'Error executing query',
    },
    (sqlDriver, { sql }) => executeSql(sqlDriver, sql)
  );

  server.registerTool(
    'list_databases',
    {
      description:
        'List the databases this server can query, with the state of each connection pool and any configuration errors.',
      inputSchema: {},
      annotations: { title: 'List Databases', readOnlyHint: true },
    },
    async () => {
      try {
        return formatTextResponse(toJson(await registry.list()));
      } catch (error) {
        log('ERROR', `Error listing databases: ${errorMessage(error)}`);
        return formatError(error);
      }
    }
  );

  if (offersCancelQuery(registry)) {
    server.registerTool(
      'cancel_query',
      {
        description:
          "List this session's running tool calls, or cancel one by call_id. Cancelling stops its statement in Postgres. Only reachable if the client can issue a call while another is running, or has given up on one.",
        inputSchema: {
          call_id: z.string().optional().describe('Id of the call to cancel, from the list returned without it'),
        },
        annotations: { title: 'Cancel Query', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      ({ call_id }) => {
        if (call_id === undefined) {
          return formatTextResponse(toJson(calls.list()));
        }
        return calls.cancel(call_id)
          ? formatTextResponse(toJson({ cancelled: true, call_id }))
          : formatError(new Error(`No running call with call_id "${call_id}"`));
      }
    );
  }

  return server;
}
