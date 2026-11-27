import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import { constants as osConstants } from 'node:os';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import packageJson from '../package.json' with { type: 'json' };
import { ErrorResult, ExplainPlanArtifact } from './artifacts.ts';
import { exitOnCliError, HELP, httpOptions, parseCli } from './cli.ts';
import { resolveConfig } from './config.ts';
import { DatabaseHealthTool, HEALTH_TYPES } from './database-health/database-health.ts';
import { DatabaseAccessError, DatabaseRegistry } from './database-registry.ts';
import { ExplainPlanTool } from './explain/explain-plan.ts';
import { DatabaseTuningAdvisor } from './index/dta-calc.ts';
import { MAX_NUM_INDEX_TUNING_QUERIES } from './index/index-opt-base.ts';
import { TextPresentation } from './index/presentation.ts';
import { RunningCalls } from './running-calls.ts';
import { AccessMode } from './sql/driver-factory.ts';
import { checkHypopgInstallationStatus } from './sql/extension-utils.ts';
import type { SqlExecutor } from './sql/safe-sql.ts';
import { SafeSqlDriver } from './sql/safe-sql.ts';
import { isStatementError } from './sql/sql-driver.ts';
import { TopQueriesCalc } from './top-queries/top-queries-calc.ts';
import type { HttpServerOptions } from './transports/request-guard.ts';
import { guardRequests, LOOPBACK_HOSTS } from './transports/request-guard.ts';
import { SessionStore } from './transports/sessions.ts';

const SERVER_NAME = 'postgres-mcp';
const SERVER_VERSION = packageJson.version;
const PG_STAT_STATEMENTS = 'pg_stat_statements';

function log(level: string, message: string): void {
  process.stderr.write(`${level}: ${message}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item));
}

function formatTextResponse(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

/**
 * Upstream's `Error: ...` text. A failure Postgres raised for the statement keeps upstream's plain result; any other
 * failure (configuration, connection including a FATAL report, restricted-mode rejection, timeout, argument check,
 * internal) sets `isError`.
 */
function formatError(error: unknown): CallToolResult {
  const [message, cause] = error instanceof ErrorResult ? [error.toText(), error.cause] : [errorMessage(error), error];
  const result = formatTextResponse(`Error: ${message}`);
  return isStatementError(cause) ? result : { ...result, isError: true };
}

function cell(row: { cells: Record<string, unknown> }, name: string): unknown {
  return row.cells[name];
}

const HYPOTHETICAL_INDEXES_DESCRIPTION = `A list of hypothetical indexes to simulate. Each index must be a dictionary with these keys:
    - 'table': The table name to add the index to (e.g., 'users')
    - 'columns': List of column names to include in the index (e.g., ['email'] or ['last_name', 'first_name'])
    - 'using': Optional index method (default: 'btree', other options include 'hash', 'gist', etc.)

Examples: [
    {"table": "users", "columns": ["email"], "using": "btree"},
    {"table": "orders", "columns": ["user_id", "created_at"]}
]
If there is no hypothetical index, you can pass an empty list.`;

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

async function listSchemas(sqlDriver: SqlExecutor): Promise<CallToolResult> {
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

async function listObjects(sqlDriver: SqlExecutor, schemaName: string, objectType: string): Promise<CallToolResult> {
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

async function getObjectDetails(
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

async function explainQuery(
  sqlDriver: SqlExecutor,
  sql: string,
  analyze: boolean,
  hypotheticalIndexes: Record<string, unknown>[]
): Promise<CallToolResult> {
  const explainTool = new ExplainPlanTool(sqlDriver);
  let result: ExplainPlanArtifact | ErrorResult;

  // If hypothetical indexes are specified, check for HypoPG extension
  if (hypotheticalIndexes.length > 0) {
    if (analyze) {
      return formatError('Cannot use analyze and hypothetical indexes together');
    }
    const [isHypopgInstalled, hypopgMessage] = await checkHypopgInstallationStatus(sqlDriver);

    // If hypopg is not installed, return the message
    if (!isHypopgInstalled) {
      return formatTextResponse(hypopgMessage);
    }

    result = await explainTool.explainWithHypotheticalIndexes(sql, hypotheticalIndexes);
  } else if (analyze) {
    result = await explainTool.explainAnalyze(sql);
  } else {
    result = await explainTool.explain(sql);
  }

  if (result instanceof ExplainPlanArtifact) {
    return formatTextResponse(result.toText());
  }
  return formatError(result);
}

async function executeSql(sqlDriver: SqlExecutor, sql: string): Promise<CallToolResult> {
  const rows = await sqlDriver.executeQuery(sql);
  if (rows === null) {
    return formatTextResponse('No results');
  }
  return formatTextResponse(toJson(rows.map((r) => r.cells)));
}

async function analyzeWorkloadIndexes(sqlDriver: SqlExecutor, maxIndexSizeMb: number): Promise<CallToolResult> {
  const indexTuning = new DatabaseTuningAdvisor(sqlDriver);
  const dtaTool = new TextPresentation(sqlDriver, indexTuning);
  const result = await dtaTool.analyzeWorkload(maxIndexSizeMb);
  return formatTextResponse(toJson(result));
}

async function analyzeQueryIndexes(
  sqlDriver: SqlExecutor,
  queries: string[],
  maxIndexSizeMb: number
): Promise<CallToolResult> {
  if (queries.length === 0) {
    return formatError('Please provide a non-empty list of queries to analyze.');
  }
  if (queries.length > MAX_NUM_INDEX_TUNING_QUERIES) {
    return formatError(`Please provide a list of up to ${MAX_NUM_INDEX_TUNING_QUERIES} queries to analyze.`);
  }

  const indexTuning = new DatabaseTuningAdvisor(sqlDriver);
  const dtaTool = new TextPresentation(sqlDriver, indexTuning);
  const result = await dtaTool.analyzeQueries(queries, maxIndexSizeMb);
  return formatTextResponse(toJson(result));
}

async function analyzeDbHealth(sqlDriver: SqlExecutor, healthType: string): Promise<CallToolResult> {
  const healthTool = new DatabaseHealthTool(sqlDriver);
  return formatTextResponse(await healthTool.health(healthType));
}

async function getTopQueries(sqlDriver: SqlExecutor, sortBy: string, limit: number): Promise<CallToolResult> {
  const topQueriesTool = new TopQueriesCalc(sqlDriver);

  if (sortBy === 'resources') {
    return formatTextResponse(await topQueriesTool.getTopResourceQueries());
  }
  if (sortBy === 'mean_time' || sortBy === 'total_time') {
    return formatTextResponse(
      await topQueriesTool.getTopQueriesByTime(limit, sortBy === 'mean_time' ? 'mean' : 'total')
    );
  }
  return formatError("Invalid sort criteria. Please use 'resources' or 'mean_time' or 'total_time'.");
}

function accessModeClause({ accessMode, statementTimeoutSeconds: seconds }: DatabaseRegistry): string {
  if (accessMode === AccessMode.RESTRICTED) {
    return seconds > 0
      ? `Access mode is restricted: read-only, and Postgres cancels each statement after ${seconds} s.`
      : 'Access mode is restricted: read-only, with no statement timeout.';
  }
  return seconds > 0
    ? `Access mode is unrestricted: statements can write, and Postgres cancels each statement after ${seconds} s.`
    : 'Access mode is unrestricted: statements can write and have no timeout.';
}

/** Whether the cancel_query tool is registered; it is only in unrestricted mode. */
function offersCancelQuery(registry: DatabaseRegistry): boolean {
  return registry.accessMode === AccessMode.UNRESTRICTED;
}

/** Sent to every client at initialization; each clause costs tokens in every session, so keep them short. */
function serverInstructions(registry: DatabaseRegistry): string {
  const { explicit, serverCount, prefixed } = registry.describe();
  const clauses = [
    offersCancelQuery(registry)
      ? 'Every tool except list_databases and cancel_query requires a "database" argument.'
      : 'Every tool except list_databases requires a "database" argument.',
    explicit.length > 0 ? `Configured databases: ${explicit.join(', ')}.` : '',
    serverCount > 0
      ? `More databases are discovered on ${serverCount} server(s); call list_databases to see them all.`
      : "Call list_databases to see each database's connection state.",
    prefixed ? "Discovered names carry their server's prefix; inside the database the name is unprefixed." : '',
    accessModeClause(registry),
    'Cancelling a call cancels its running statement.',
    offersCancelQuery(registry) ? 'Call cancel_query to list running calls or cancel one by call_id.' : '',
    'An "Error:" result without isError is Postgres rejecting the statement; with isError the SQL got no answer from Postgres (restricted-mode refusal, invalid argument, connection, configuration or server failure).',
    'The health, top-queries and index tools report failures in their output instead.',
    // oxlint-disable-next-line eslint/no-template-curly-in-string -- the literal ${VAR} names the config syntax
    'On a failure, show the user the error first, then check likely causes: an unset ${VAR}, wrong credentials, an unreachable host, or missing grants (which also empty the listing tools). list_databases shows the last connection error of each database.',
    `Report any problem with this MCP server to the user (bugs, confusing output, missing tools or arguments) and suggest an issue at ${packageJson.bugs.url}.`,
  ];
  return clauses.filter((clause) => clause !== '').join(' ');
}

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
   * cancel_query, and turns a failure into an `Error:` result (logged under `errorLog`, except database access failures).
   */
  const registerDatabaseTool = <Shape extends z.ZodRawShape>(
    name: string,
    {
      errorLog,
      inputSchema,
      ...config
    }: { description: string; annotations: ToolAnnotations; errorLog: string; inputSchema: Shape },
    body: (sqlDriver: SqlExecutor, args: z.output<z.ZodObject<Shape>>) => Promise<CallToolResult>
  ): void => {
    server.registerTool<z.ZodRawShape, z.ZodRawShape>(
      name,
      { ...config, inputSchema: { database: databaseSchema, ...inputSchema } },
      async (validated, { signal }) => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the SDK has parsed the arguments against this inputSchema, but its callback type cannot follow a generic shape
        const args = validated as { database: string } & z.output<z.ZodObject<Shape>>;
        try {
          return await calls.track(name, args.database, signal, (callSignal) =>
            registry.use(args.database, (sqlDriver) => body(sqlDriver, args), { signal: callSignal })
          );
        } catch (error) {
          if (!(error instanceof DatabaseAccessError)) {
            log('ERROR', `${errorLog}: ${errorMessage(error)}`);
          }
          return formatError(error);
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
          .array(z.record(z.string(), z.unknown()))
          .default([])
          .describe(HYPOTHETICAL_INDEXES_DESCRIPTION),
      },
      annotations: { title: 'Explain Query', readOnlyHint: true },
      errorLog: 'Error explaining query',
    },
    (sqlDriver, { sql, analyze, hypothetical_indexes }) => explainQuery(sqlDriver, sql, analyze, hypothetical_indexes)
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
        sql: z.string().default('all').describe('SQL to run'),
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

type ServerFactory = () => McpServer;

const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** A running HTTP transport: the bound port and a way to stop it. */
export interface HttpServerHandle {
  close: () => Promise<void>;
  port: number;
}

function warnIfExposed(http: HttpServerOptions, accessMode: string): void {
  if (!LOOPBACK_HOSTS.has(http.host)) {
    const hostChecks = http.allowedHosts === 'any' ? ' Host checks are disabled by --allowed-hosts=*.' : '';
    log(
      'WARNING',
      `Listening on ${http.host}: the server is reachable from the network with no authentication.${hostChecks} Anyone who can connect can run queries in ${accessMode.toUpperCase()} mode.`
    );
  }
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflowed = false;
    req.on('data', (chunk: Buffer) => {
      if (overflowed) {
        return;
      }
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Keep the socket open so the client can read the 413.
        overflowed = true;
        chunks.length = 0;
        reject(new RangeError('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (overflowed) {
        return;
      }
      const text = Buffer.concat(chunks).toString('utf-8');
      if (!text) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new SyntaxError('Parse error: Invalid JSON'));
      }
    });
  });
}

function sendJsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  if (res.headersSent) {
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

function sendBodyTooLarge(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('Connection', 'close');
  sendJsonRpcError(res, 413, -32_600, 'Request body too large');
  res.once('finish', () => {
    req.destroy();
  });
}

/** Starts listening and resolves with the port the OS actually bound. */
function listen(httpServer: ReturnType<typeof createHttpServer>, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject);
      const address = httpServer.address();
      resolve(typeof address === 'object' && address ? address.port : port);
    });
  });
}

function closeHttpServer(httpServer: ReturnType<typeof createHttpServer>): Promise<void> {
  return new Promise((resolve) => {
    httpServer.close(() => {
      resolve();
    });
    httpServer.closeAllConnections();
  });
}

function parseRequestUrl(req: IncomingMessage): URL | null {
  try {
    return new URL(req.url ?? '/', 'http://localhost');
  } catch {
    return null;
  }
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function runStdio(createMcpServer: ServerFactory, onClientGone: () => void): Promise<void> {
  const server = createMcpServer();
  let closing = false;
  const handleClientGone = () => {
    if (closing) {
      return;
    }
    closing = true;
    onClientGone();
  };
  // StdioServerTransport does not report stdin EOF through onclose.
  server.server.onclose = handleClientGone;
  process.stdin.once('end', handleClientGone);
  process.stdin.once('close', handleClientGone);
  await server.connect(new StdioServerTransport());
}

const SSE_SESSION_PARAM = 'sessionId';

function logCloseFailure(what: string): (error: unknown) => void {
  return (error) => {
    log('ERROR', `Error closing ${what}: ${errorMessage(error)}`);
  };
}

/** Keeps the session's idle timer stopped until the response closes. */
function holdSession<T extends { close: () => Promise<void> }>(
  store: SessionStore<T>,
  id: string,
  res: ServerResponse
): void {
  store.begin(id);
  res.once('close', () => {
    store.end(id);
  });
}

/**
 * Listens, then serves requests that pass the Host and Origin check. The handler
 * attaches after listening because the default allow-list names the bound port.
 */
async function listenGuarded(
  label: string,
  path: string,
  options: HttpServerOptions,
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ httpServer: ReturnType<typeof createHttpServer>; port: number }> {
  const httpServer = createHttpServer();
  const port = await listen(httpServer, options.host, options.port);
  httpServer.on('request', guardRequests(options, port, handler));
  log('INFO', `${label} listening on http://${options.host}:${port}${path}`);
  return { httpServer, port };
}

// oxlint-disable-next-line typescript/no-deprecated -- the SSE transport is part of the upstream CLI surface
type SseSessions = SessionStore<SSEServerTransport>;

async function handleSseRequest(
  createMcpServer: ServerFactory,
  store: SseSessions,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = parseRequestUrl(req);
  if (!url) {
    res.writeHead(400).end('Bad Request');
    return;
  }
  const path = url.pathname;
  if (req.method === 'GET' && path === '/sse') {
    if (store.full) {
      res.writeHead(503).end('Too many sessions');
      return;
    }
    // oxlint-disable-next-line typescript/no-deprecated -- the SSE transport is part of the upstream CLI surface
    const transport = new SSEServerTransport('/messages', res);
    const mcpServer = createMcpServer();
    store.add(transport.sessionId, transport);
    res.on('close', () => {
      store.remove(transport.sessionId);
      mcpServer.close().catch(logCloseFailure(`SSE session ${transport.sessionId}`));
    });
    await mcpServer.connect(transport);
    return;
  }
  if (req.method === 'POST' && path === '/messages') {
    const sessionId = url.searchParams.get(SSE_SESSION_PARAM);
    const transport = sessionId ? store.get(sessionId) : undefined;
    if (!transport) {
      res.writeHead(sessionId ? 404 : 400).end('Could not find session');
      return;
    }
    await transport.handlePostMessage(req, res);
    return;
  }
  res.writeHead(404).end('Not Found');
}

/** Serve MCP over SSE and resolve once listening. */
export async function startSseServer(
  createMcpServer: ServerFactory,
  options: HttpServerOptions
): Promise<HttpServerHandle> {
  // oxlint-disable-next-line typescript/no-deprecated -- the SSE transport is part of the upstream CLI surface
  const store: SseSessions = new SessionStore<SSEServerTransport>(options);

  const { httpServer, port } = await listenGuarded('SSE server', '/sse', options, (req, res) => {
    handleSseRequest(createMcpServer, store, req, res).catch((error: unknown) => {
      log('ERROR', `SSE request failed: ${errorMessage(error)}`);
      if (!res.headersSent) {
        res.writeHead(500).end('Internal Server Error');
      }
    });
  });
  return {
    port,
    close: async () => {
      await store.closeAll();
      await closeHttpServer(httpServer);
    },
  };
}

type McpSessions = SessionStore<StreamableHTTPServerTransport>;

async function startMcpSession(
  createMcpServer: ServerFactory,
  store: McpSessions,
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown
): Promise<void> {
  // The id is chosen up front so the session counts against the cap before the first await.
  const id = randomUUID();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => id });
  transport.onclose = () => {
    store.remove(id);
  };
  store.add(id, transport);
  holdSession(store, id, res);
  let initialized = false;
  try {
    await createMcpServer().connect(transport);
    await transport.handleRequest(req, res, body);
    initialized = transport.sessionId === id && res.statusCode >= 200 && res.statusCode < 300;
  } finally {
    if (!initialized) {
      store.remove(id);
      transport.close().catch(logCloseFailure(`session ${id}`));
    }
  }
}

async function handleMcpRequest(
  createMcpServer: ServerFactory,
  store: McpSessions,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const sessionId = headerValue(req, 'mcp-session-id');
  const existing = sessionId ? store.get(sessionId) : undefined;
  if (sessionId && existing) {
    holdSession(store, sessionId, res);
  }

  if (req.method === 'POST') {
    const body = await readBody(req);
    if (existing) {
      await existing.handleRequest(req, res, body);
    } else if (!sessionId && isInitializeRequest(body)) {
      if (store.full) {
        sendJsonRpcError(res, 503, -32_000, 'Too many sessions');
        return;
      }
      await startMcpSession(createMcpServer, store, req, res, body);
    } else {
      sendMissingSession(res, sessionId);
    }
    return;
  }

  if (req.method === 'GET' || req.method === 'DELETE') {
    if (existing) {
      await existing.handleRequest(req, res);
    } else {
      sendMissingSession(res, sessionId);
    }
    return;
  }

  res.writeHead(405, { Allow: 'GET, POST, DELETE' }).end();
}

function sendMissingSession(res: ServerResponse, sessionId: string | undefined): void {
  if (sessionId) {
    sendJsonRpcError(res, 404, -32_000, 'Session not found');
  } else {
    sendJsonRpcError(res, 400, -32_000, 'Bad Request: No valid session ID provided');
  }
}

/** Serve MCP over streamable HTTP and resolve once listening. */
export async function startStreamableHttpServer(
  createMcpServer: ServerFactory,
  options: HttpServerOptions
): Promise<HttpServerHandle> {
  const store: McpSessions = new SessionStore(options);

  const { httpServer, port } = await listenGuarded('Streamable HTTP server', '/mcp', options, (req, res) => {
    const path = parseRequestUrl(req)?.pathname;
    if (path === undefined) {
      res.writeHead(400).end('Bad Request');
      return;
    }
    if (path !== '/mcp') {
      res.writeHead(404).end('Not Found');
      return;
    }
    handleMcpRequest(createMcpServer, store, req, res).catch((error: unknown) => {
      log('ERROR', `Streamable HTTP request failed: ${errorMessage(error)}`);
      if (error instanceof RangeError) {
        sendBodyTooLarge(req, res);
        return;
      }
      const badJson = error instanceof SyntaxError;
      sendJsonRpcError(
        res,
        badJson ? 400 : 500,
        badJson ? -32_700 : -32_603,
        badJson ? 'Parse error' : 'Internal server error'
      );
    });
  });
  return {
    port,
    close: async () => {
      await store.closeAll();
      await closeHttpServer(httpServer);
    },
  };
}

async function runSse(createMcpServer: ServerFactory, options: HttpServerOptions): Promise<void> {
  await startSseServer(createMcpServer, options);
}

async function runStreamableHttp(createMcpServer: ServerFactory, options: HttpServerOptions): Promise<void> {
  await startStreamableHttpServer(createMcpServer, options);
}

/** Replaceable seams so tests can observe which transport ran. */
export const runners = { runStdio, runSse, runStreamableHttp };

let shutdownInProgress = false;

/** Clean shutdown of the server. */
export async function shutdown(registry: DatabaseRegistry, signal?: NodeJS.Signals): Promise<void> {
  if (shutdownInProgress) {
    log('WARNING', 'Forcing immediate exit');
    process.exit(1);
  }
  shutdownInProgress = true;

  if (signal) {
    log('INFO', `Received exit signal ${signal}`);
  }

  try {
    await registry.closeAll();
    log('INFO', 'Closed database connections');
  } catch (error) {
    log('ERROR', `Error closing database connections: ${errorMessage(error)}`);
  }

  process.exit(signal ? 128 + (osConstants.signals[signal] ?? 0) : 0);
}

const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;
let removeSignalHandlers: (() => void) | null = null;

/** Route SIGTERM/SIGINT to this registry's shutdown, replacing handlers from an earlier `main` call. */
function installSignalHandlers(registry: DatabaseRegistry): void {
  removeSignalHandlers?.();
  const handler = (signal: NodeJS.Signals) => {
    void shutdown(registry, signal);
  };
  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, handler);
  }
  removeSignalHandlers = () => {
    for (const signal of SHUTDOWN_SIGNALS) {
      process.off(signal, handler);
    }
  };
}

export async function main(argv: string[]): Promise<void> {
  const options = exitOnCliError(() => parseCli(argv));
  if (options === null) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const resolved = exitOnCliError(() => resolveConfig(options, process.env, (path) => readFileSync(path, 'utf-8')));

  const registry = new DatabaseRegistry(resolved);
  const { accessMode } = registry;
  log(
    'INFO',
    `Starting PostgreSQL MCP Server in ${accessMode.toUpperCase()} mode with ${resolved.databases.length} configured database(s) and ${resolved.servers.length} server(s)`
  );

  installSignalHandlers(registry);

  const http = httpOptions(options);
  if (http) {
    warnIfExposed(http, accessMode);
  }

  const factory = () => createServer(registry);
  if (http === undefined) {
    await runners.runStdio(factory, () => {
      void shutdown(registry);
    });
  } else if (options.transport === 'sse') {
    await runners.runSse(factory, http);
  } else {
    await runners.runStreamableHttp(factory, http);
  }
}
