import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import { constants as osConstants } from 'node:os';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import packageJson from '../package.json' with { type: 'json' };
import { ErrorResult, ExplainPlanArtifact } from './artifacts.ts';
import { exitOnCliError, HELP, parseCli } from './cli.ts';
import { resolveConfig } from './config.ts';
import { DatabaseHealthTool, HEALTH_TYPES } from './database-health/database-health.ts';
import { DatabaseAccessError, DatabaseRegistry } from './database-registry.ts';
import { ExplainPlanTool } from './explain/explain-plan.ts';
import { DatabaseTuningAdvisor } from './index/dta-calc.ts';
import { MAX_NUM_INDEX_TUNING_QUERIES } from './index/index-opt-base.ts';
import { TextPresentation } from './index/presentation.ts';
import { AccessMode, getSqlDriver } from './sql/driver-factory.ts';
import { checkHypopgInstallationStatus } from './sql/extension-utils.ts';
import type { SqlExecutor } from './sql/safe-sql.ts';
import { SafeSqlDriver } from './sql/safe-sql.ts';
import { TopQueriesCalc } from './top-queries/top-queries-calc.ts';

const SERVER_NAME = 'postgres-mcp';
const SERVER_VERSION = packageJson.version;
const PG_STAT_STATEMENTS = 'pg_stat_statements';

function log(level: string, message: string): void {
  process.stderr.write(`${level}: ${message}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Replaceable seam so tests can supply a driver without a database. */
export const deps = { getSqlDriver };

function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item));
}

function formatTextResponse(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function formatError(error: string): CallToolResult {
  return formatTextResponse(`Error: ${error}`);
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
  try {
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
  } catch (error) {
    log('ERROR', `Error listing schemas: ${errorMessage(error)}`);
    return formatError(errorMessage(error));
  }
}

async function listObjects(sqlDriver: SqlExecutor, schemaName: string, objectType: string): Promise<CallToolResult> {
  try {
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
  } catch (error) {
    log('ERROR', `Error listing objects: ${errorMessage(error)}`);
    return formatError(errorMessage(error));
  }
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
  try {
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
  } catch (error) {
    log('ERROR', `Error getting object details: ${errorMessage(error)}`);
    return formatError(errorMessage(error));
  }
}

async function explainQuery(
  sqlDriver: SqlExecutor,
  sql: string,
  analyze: boolean,
  hypotheticalIndexes: Record<string, unknown>[]
): Promise<CallToolResult> {
  try {
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
    return formatError(result instanceof ErrorResult ? result.toText() : 'Error processing explain plan');
  } catch (error) {
    log('ERROR', `Error explaining query: ${errorMessage(error)}`);
    return formatError(errorMessage(error));
  }
}

async function executeSql(sqlDriver: SqlExecutor, sql: string): Promise<CallToolResult> {
  try {
    const rows = await sqlDriver.executeQuery(sql);
    if (rows === null) {
      return formatTextResponse('No results');
    }
    return formatTextResponse(toJson(rows.map((r) => r.cells)));
  } catch (error) {
    log('ERROR', `Error executing query: ${errorMessage(error)}`);
    return formatError(errorMessage(error));
  }
}

async function analyzeWorkloadIndexes(sqlDriver: SqlExecutor, maxIndexSizeMb: number): Promise<CallToolResult> {
  try {
    const indexTuning = new DatabaseTuningAdvisor(sqlDriver);
    const dtaTool = new TextPresentation(sqlDriver, indexTuning);
    const result = await dtaTool.analyzeWorkload(maxIndexSizeMb);
    return formatTextResponse(toJson(result));
  } catch (error) {
    log('ERROR', `Error analyzing workload: ${errorMessage(error)}`);
    return formatError(errorMessage(error));
  }
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

  try {
    const indexTuning = new DatabaseTuningAdvisor(sqlDriver);
    const dtaTool = new TextPresentation(sqlDriver, indexTuning);
    const result = await dtaTool.analyzeQueries(queries, maxIndexSizeMb);
    return formatTextResponse(toJson(result));
  } catch (error) {
    log('ERROR', `Error analyzing queries: ${errorMessage(error)}`);
    return formatError(errorMessage(error));
  }
}

async function analyzeDbHealth(sqlDriver: SqlExecutor, healthType: string): Promise<CallToolResult> {
  const healthTool = new DatabaseHealthTool(sqlDriver);
  return formatTextResponse(await healthTool.health(healthType));
}

async function getTopQueries(sqlDriver: SqlExecutor, sortBy: string, limit: number): Promise<CallToolResult> {
  try {
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
  } catch (error) {
    log('ERROR', `Error getting slow queries: ${errorMessage(error)}`);
    return formatError(errorMessage(error));
  }
}

function serverInstructions(registry: DatabaseRegistry): string {
  const { explicit, serverCount } = registry.describe();
  return `Every tool except list_databases requires a "database" argument.${
    explicit.length > 0 ? ` Configured databases: ${explicit.join(', ')}.` : ''
  }${
    serverCount > 0
      ? ` More databases are discovered on ${serverCount} server(s); call list_databases to see them all.`
      : " Call list_databases to see each database's connection state."
  }`;
}

/** Build an MCP server with every tool registered against the registry's databases and access mode. */
export function createServer(registry: DatabaseRegistry): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: serverInstructions(registry) }
  );

  /** Run a tool body against a named database; access failures become tool errors. */
  const onDatabase = async (
    database: string,
    fn: (sqlDriver: SqlExecutor) => Promise<CallToolResult>
  ): Promise<CallToolResult> => {
    try {
      return await registry.use(database, fn);
    } catch (error) {
      // Errors thrown by the tool body keep their own handling; only access failures are reported here.
      if (error instanceof DatabaseAccessError) {
        return formatError(error.message);
      }
      throw error;
    }
  };

  server.registerTool(
    'list_schemas',
    {
      description: 'List all schemas in the database',
      inputSchema: { database: databaseSchema },
      annotations: { title: 'List Schemas', readOnlyHint: true },
    },
    ({ database }) => onDatabase(database, (sqlDriver) => listSchemas(sqlDriver))
  );

  server.registerTool(
    'list_objects',
    {
      description: 'List objects in a schema',
      inputSchema: {
        database: databaseSchema,
        schema_name: z.string().describe('Schema name'),
        object_type: objectTypeSchema,
      },
      annotations: { title: 'List Objects', readOnlyHint: true },
    },
    ({ database, schema_name, object_type }) =>
      onDatabase(database, (sqlDriver) => listObjects(sqlDriver, schema_name, object_type))
  );

  server.registerTool(
    'get_object_details',
    {
      description: 'Show detailed information about a database object',
      inputSchema: {
        database: databaseSchema,
        schema_name: z.string().describe('Schema name'),
        object_name: z.string().describe('Object name'),
        object_type: objectTypeSchema,
      },
      annotations: { title: 'Get Object Details', readOnlyHint: true },
    },
    ({ database, schema_name, object_name, object_type }) =>
      onDatabase(database, (sqlDriver) => getObjectDetails(sqlDriver, schema_name, object_name, object_type))
  );

  server.registerTool(
    'explain_query',
    {
      description:
        'Explains the execution plan for a SQL query, showing how the database will execute it and provides detailed cost estimates.',
      inputSchema: {
        database: databaseSchema,
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
    },
    ({ database, sql, analyze, hypothetical_indexes }) =>
      onDatabase(database, (sqlDriver) => explainQuery(sqlDriver, sql, analyze, hypothetical_indexes))
  );

  server.registerTool(
    'analyze_workload_indexes',
    {
      description: 'Analyze frequently executed queries in the database and recommend optimal indexes',
      inputSchema: {
        database: databaseSchema,
        max_index_size_mb: maxIndexSizeSchema,
        method: methodSchema,
      },
      annotations: { title: 'Analyze Workload Indexes', readOnlyHint: true },
    },
    ({ database, max_index_size_mb }) =>
      onDatabase(database, (sqlDriver) => analyzeWorkloadIndexes(sqlDriver, max_index_size_mb))
  );

  server.registerTool(
    'analyze_query_indexes',
    {
      description: 'Analyze a list of (up to 10) SQL queries and recommend optimal indexes',
      inputSchema: {
        database: databaseSchema,
        queries: z.array(z.string()).describe('List of Query strings to analyze'),
        max_index_size_mb: maxIndexSizeSchema,
        method: methodSchema,
      },
      annotations: { title: 'Analyze Query Indexes', readOnlyHint: true },
    },
    ({ database, queries, max_index_size_mb }) =>
      onDatabase(database, (sqlDriver) => analyzeQueryIndexes(sqlDriver, queries, max_index_size_mb))
  );

  server.registerTool(
    'analyze_db_health',
    {
      description: HEALTH_DESCRIPTION,
      inputSchema: {
        database: databaseSchema,
        health_type: z
          .string()
          .default('all')
          .describe(`Optional. Valid values are: ${HEALTH_TYPES.toSorted().join(', ')}.`),
      },
      annotations: { title: 'Analyze Database Health', readOnlyHint: true },
    },
    ({ database, health_type }) => onDatabase(database, (sqlDriver) => analyzeDbHealth(sqlDriver, health_type))
  );

  server.registerTool(
    'get_top_queries',
    {
      description: `Reports the slowest or most resource-intensive queries using data from the '${PG_STAT_STATEMENTS}' extension.`,
      inputSchema: {
        database: databaseSchema,
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
    },
    ({ database, sort_by, limit }) => onDatabase(database, (sqlDriver) => getTopQueries(sqlDriver, sort_by, limit))
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
  server.registerTool(
    'execute_sql',
    {
      ...executeSqlConfig,
      inputSchema: {
        database: databaseSchema,
        sql: z.string().default('all').describe('SQL to run'),
      },
    },
    ({ database, sql }) => onDatabase(database, (sqlDriver) => executeSql(sqlDriver, sql))
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
        return formatError(errorMessage(error));
      }
    }
  );

  return server;
}

type ServerFactory = () => McpServer;

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

interface HostGuard {
  allowedHosts?: string[];
  enableDnsRebindingProtection?: boolean;
}

/** A running HTTP transport: the bound port and a way to stop it. */
export interface HttpServerHandle {
  close: () => Promise<void>;
  port: number;
}

/**
 * A server bound to loopback only accepts requests addressed to loopback, so
 * a web page cannot reach it through a DNS name it controls.
 */
function hostGuard(host: string, port: number): HostGuard {
  if (!LOOPBACK_HOSTS.has(host)) {
    return {};
  }
  return {
    enableDnsRebindingProtection: true,
    allowedHosts: [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`],
  };
}

/** The message for a request whose Host header the guard rejects, if any. */
function hostViolation(guard: HostGuard, req: IncomingMessage): string | null {
  if (!(guard.enableDnsRebindingProtection && guard.allowedHosts)) {
    return null;
  }
  const hostHeader = req.headers.host;
  if (hostHeader && guard.allowedHosts.includes(hostHeader)) {
    return null;
  }
  return `Invalid Host header: ${hostHeader}`;
}

function warnIfExposed(host: string, accessMode: string): void {
  if (!LOOPBACK_HOSTS.has(host)) {
    log(
      'WARNING',
      `Listening on ${host}: the server is reachable from the network with no authentication and no Host or Origin checks. Anyone who can connect can run queries in ${accessMode.toUpperCase()} mode.`
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

async function handleSseRequest(
  createMcpServer: ServerFactory,
  // oxlint-disable-next-line typescript/no-deprecated -- the SSE transport is part of the upstream CLI surface
  sessions: Map<string, SSEServerTransport>,
  guard: HostGuard,
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
    const violation = hostViolation(guard, req);
    if (violation) {
      res.writeHead(403).end(violation);
      return;
    }
    // oxlint-disable-next-line typescript/no-deprecated -- the SSE transport is part of the upstream CLI surface
    const transport = new SSEServerTransport('/messages', res, guard);
    sessions.set(transport.sessionId, transport);
    const mcpServer = createMcpServer();
    res.on('close', () => {
      sessions.delete(transport.sessionId);
      void mcpServer.close();
    });
    await mcpServer.connect(transport);
    return;
  }
  if (req.method === 'POST' && path === '/messages') {
    const sessionId = url.searchParams.get(SSE_SESSION_PARAM);
    const transport = sessionId ? sessions.get(sessionId) : undefined;
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
  host: string,
  port: number
): Promise<HttpServerHandle> {
  // oxlint-disable-next-line typescript/no-deprecated -- the SSE transport is part of the upstream CLI surface
  const sessions = new Map<string, SSEServerTransport>();
  const state: { guard: HostGuard } = { guard: {} };

  const httpServer = createHttpServer((req, res) => {
    handleSseRequest(createMcpServer, sessions, state.guard, req, res).catch((error: unknown) => {
      log('ERROR', `SSE request failed: ${errorMessage(error)}`);
      if (!res.headersSent) {
        res.writeHead(500).end('Internal Server Error');
      }
    });
  });

  const boundPort = await listen(httpServer, host, port);
  state.guard = hostGuard(host, boundPort);
  log('INFO', `SSE server listening on http://${host}:${boundPort}/sse`);
  return { port: boundPort, close: () => closeHttpServer(httpServer) };
}

type McpSessions = Map<string, StreamableHTTPServerTransport>;

async function startMcpSession(
  createMcpServer: ServerFactory,
  sessions: McpSessions,
  guard: HostGuard,
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown
): Promise<void> {
  const transport = new StreamableHTTPServerTransport({
    ...guard,
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, transport);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) {
      sessions.delete(transport.sessionId);
    }
  };
  await createMcpServer().connect(transport);
  await transport.handleRequest(req, res, body);
}

async function handleMcpRequest(
  createMcpServer: ServerFactory,
  sessions: McpSessions,
  guard: HostGuard,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const sessionId = headerValue(req, 'mcp-session-id');
  const existing = sessionId ? sessions.get(sessionId) : undefined;

  if (req.method === 'POST') {
    const body = await readBody(req);
    if (existing) {
      await existing.handleRequest(req, res, body);
    } else if (!sessionId && isInitializeRequest(body)) {
      await startMcpSession(createMcpServer, sessions, guard, req, res, body);
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
  host: string,
  port: number
): Promise<HttpServerHandle> {
  const sessions: McpSessions = new Map();
  const state: { guard: HostGuard } = { guard: {} };

  const httpServer = createHttpServer((req, res) => {
    const path = parseRequestUrl(req)?.pathname;
    if (path === undefined) {
      res.writeHead(400).end('Bad Request');
      return;
    }
    if (path !== '/mcp') {
      res.writeHead(404).end('Not Found');
      return;
    }
    handleMcpRequest(createMcpServer, sessions, state.guard, req, res).catch((error: unknown) => {
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

  const boundPort = await listen(httpServer, host, port);
  state.guard = hostGuard(host, boundPort);
  log('INFO', `Streamable HTTP server listening on http://${host}:${boundPort}/mcp`);
  return {
    port: boundPort,
    close: async () => {
      await Promise.all([...sessions.values()].map((transport) => transport.close()));
      await closeHttpServer(httpServer);
    },
  };
}

async function runSse(createMcpServer: ServerFactory, host: string, port: number): Promise<void> {
  await startSseServer(createMcpServer, host, port);
}

async function runStreamableHttp(createMcpServer: ServerFactory, host: string, port: number): Promise<void> {
  await startStreamableHttpServer(createMcpServer, host, port);
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

  const registry = new DatabaseRegistry({
    ...resolved,
    getSqlDriver: (mode, conn) => deps.getSqlDriver(mode, conn),
  });
  const { accessMode } = registry;
  log(
    'INFO',
    `Starting PostgreSQL MCP Server in ${accessMode.toUpperCase()} mode with ${resolved.databases.length} configured database(s) and ${resolved.servers.length} server(s)`
  );

  installSignalHandlers(registry);

  if (options.transport === 'sse') {
    warnIfExposed(options.sseHost, accessMode);
  } else if (options.transport === 'streamable-http') {
    warnIfExposed(options.streamableHttpHost, accessMode);
  }

  const factory = () => createServer(registry);
  switch (options.transport) {
    case 'stdio': {
      await runners.runStdio(factory, () => {
        void shutdown(registry);
      });
      break;
    }
    case 'sse': {
      await runners.runSse(factory, options.sseHost, options.ssePort);
      break;
    }
    case 'streamable-http': {
      await runners.runStreamableHttp(factory, options.streamableHttpHost, options.streamableHttpPort);
      break;
    }
    default: {
      break;
    }
  }
}
