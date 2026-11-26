import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import { constants as osConstants } from 'node:os';
import { parseArgs } from 'node:util';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { ErrorResult, ExplainPlanArtifact } from './artifacts.ts';
import { DatabaseHealthTool, HEALTH_TYPES } from './database-health/database-health.ts';
import { ExplainPlanTool } from './explain/explain-plan.ts';
import { DatabaseTuningAdvisor } from './index/dta-calc.ts';
import { MAX_NUM_INDEX_TUNING_QUERIES } from './index/index-opt-base.ts';
import { TextPresentation } from './index/presentation.ts';
import { checkHypopgInstallationStatus } from './sql/extension-utils.ts';
import type { SqlExecutor } from './sql/safe-sql.ts';
import { SafeSqlDriver } from './sql/safe-sql.ts';
import { DbConnPool, obfuscatePassword, SqlDriver } from './sql/sql-driver.ts';
import { TopQueriesCalc } from './top-queries/top-queries-calc.ts';

const SERVER_NAME = 'postgres-mcp';
const SERVER_VERSION = '0.4.0'; // x-release-please-version
const PG_STAT_STATEMENTS = 'pg_stat_statements';
const RESTRICTED_TIMEOUT_SECONDS = 30;

const ACCESS_MODES = ['unrestricted', 'restricted'] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];
export const AccessMode = {
  UNRESTRICTED: 'unrestricted',
  RESTRICTED: 'restricted',
} as const satisfies Record<string, AccessMode>;

const TRANSPORTS = ['stdio', 'sse', 'streamable-http'] as const;
export type Transport = (typeof TRANSPORTS)[number];

function log(level: string, message: string): void {
  process.stderr.write(`${level}: ${message}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const dbConnection = new DbConnPool();

/** Get the appropriate SQL driver for the access mode. */
export function getSqlDriver(accessMode: AccessMode, conn: DbConnPool = dbConnection): SqlExecutor {
  const baseDriver = new SqlDriver({ conn });

  if (accessMode === AccessMode.RESTRICTED) {
    return new SafeSqlDriver(baseDriver, RESTRICTED_TIMEOUT_SECONDS);
  }
  return baseDriver;
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

const objectTypeSchema = z
  .string()
  .default('table')
  .describe("Object type: 'table', 'view', 'sequence', or 'extension'");

const methodSchema = z.enum(['dta']).default('dta').describe('Method to use for analysis');

const maxIndexSizeSchema = z.number().int().default(10_000).describe('Max index size in MB');

async function listSchemas(accessMode: AccessMode): Promise<CallToolResult> {
  try {
    const sqlDriver = deps.getSqlDriver(accessMode);
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

async function listObjects(accessMode: AccessMode, schemaName: string, objectType: string): Promise<CallToolResult> {
  try {
    const sqlDriver = deps.getSqlDriver(accessMode);
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
  accessMode: AccessMode,
  schemaName: string,
  objectName: string,
  objectType: string
): Promise<CallToolResult> {
  try {
    const sqlDriver = deps.getSqlDriver(accessMode);
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
  accessMode: AccessMode,
  sql: string,
  analyze: boolean,
  hypotheticalIndexes: Record<string, unknown>[]
): Promise<CallToolResult> {
  try {
    const sqlDriver = deps.getSqlDriver(accessMode);
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

async function executeSql(accessMode: AccessMode, sql: string): Promise<CallToolResult> {
  try {
    const sqlDriver = deps.getSqlDriver(accessMode);
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

async function analyzeWorkloadIndexes(accessMode: AccessMode, maxIndexSizeMb: number): Promise<CallToolResult> {
  try {
    const sqlDriver = deps.getSqlDriver(accessMode);
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
  accessMode: AccessMode,
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
    const sqlDriver = deps.getSqlDriver(accessMode);
    const indexTuning = new DatabaseTuningAdvisor(sqlDriver);
    const dtaTool = new TextPresentation(sqlDriver, indexTuning);
    const result = await dtaTool.analyzeQueries(queries, maxIndexSizeMb);
    return formatTextResponse(toJson(result));
  } catch (error) {
    log('ERROR', `Error analyzing queries: ${errorMessage(error)}`);
    return formatError(errorMessage(error));
  }
}

async function analyzeDbHealth(accessMode: AccessMode, healthType: string): Promise<CallToolResult> {
  const healthTool = new DatabaseHealthTool(deps.getSqlDriver(accessMode));
  return formatTextResponse(await healthTool.health(healthType));
}

async function getTopQueries(accessMode: AccessMode, sortBy: string, limit: number): Promise<CallToolResult> {
  try {
    const sqlDriver = deps.getSqlDriver(accessMode);
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

/** Build an MCP server with every tool registered for the given access mode. */
export function createServer(accessMode: AccessMode): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    'list_schemas',
    {
      description: 'List all schemas in the database',
      inputSchema: {},
      annotations: { title: 'List Schemas', readOnlyHint: true },
    },
    () => listSchemas(accessMode)
  );

  server.registerTool(
    'list_objects',
    {
      description: 'List objects in a schema',
      inputSchema: {
        schema_name: z.string().describe('Schema name'),
        object_type: objectTypeSchema,
      },
      annotations: { title: 'List Objects', readOnlyHint: true },
    },
    ({ schema_name, object_type }) => listObjects(accessMode, schema_name, object_type)
  );

  server.registerTool(
    'get_object_details',
    {
      description: 'Show detailed information about a database object',
      inputSchema: {
        schema_name: z.string().describe('Schema name'),
        object_name: z.string().describe('Object name'),
        object_type: objectTypeSchema,
      },
      annotations: { title: 'Get Object Details', readOnlyHint: true },
    },
    ({ schema_name, object_name, object_type }) => getObjectDetails(accessMode, schema_name, object_name, object_type)
  );

  server.registerTool(
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
    },
    ({ sql, analyze, hypothetical_indexes }) => explainQuery(accessMode, sql, analyze, hypothetical_indexes)
  );

  server.registerTool(
    'analyze_workload_indexes',
    {
      description: 'Analyze frequently executed queries in the database and recommend optimal indexes',
      inputSchema: {
        max_index_size_mb: maxIndexSizeSchema,
        method: methodSchema,
      },
      annotations: { title: 'Analyze Workload Indexes', readOnlyHint: true },
    },
    ({ max_index_size_mb }) => analyzeWorkloadIndexes(accessMode, max_index_size_mb)
  );

  server.registerTool(
    'analyze_query_indexes',
    {
      description: 'Analyze a list of (up to 10) SQL queries and recommend optimal indexes',
      inputSchema: {
        queries: z.array(z.string()).describe('List of Query strings to analyze'),
        max_index_size_mb: maxIndexSizeSchema,
        method: methodSchema,
      },
      annotations: { title: 'Analyze Query Indexes', readOnlyHint: true },
    },
    ({ queries, max_index_size_mb }) => analyzeQueryIndexes(accessMode, queries, max_index_size_mb)
  );

  server.registerTool(
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
    },
    ({ health_type }) => analyzeDbHealth(accessMode, health_type)
  );

  server.registerTool(
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
    },
    ({ sort_by, limit }) => getTopQueries(accessMode, sort_by, limit)
  );

  // execute_sql is described according to the access mode
  const executeSqlConfig =
    accessMode === AccessMode.UNRESTRICTED
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
        sql: z.string().default('all').describe('SQL to run'),
      },
    },
    ({ sql }) => executeSql(accessMode, sql)
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

async function runStdio(createMcpServer: ServerFactory): Promise<void> {
  const server = createMcpServer();
  let closing = false;
  const onClientGone = () => {
    if (closing) {
      return;
    }
    closing = true;
    void shutdown();
  };
  // StdioServerTransport does not report stdin EOF through onclose.
  server.server.onclose = onClientGone;
  process.stdin.once('end', onClientGone);
  process.stdin.once('close', onClientGone);
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

export interface CliOptions {
  accessMode: AccessMode;
  databaseUrl: string | undefined;
  sseHost: string;
  ssePort: number;
  streamableHttpHost: string;
  streamableHttpPort: number;
  transport: Transport;
}

export class CliError extends Error {}

const PROG = 'postgres-mcp';
const USAGE = `usage: ${PROG} [-h] [--access-mode {${ACCESS_MODES.join(',')}}]
                    [--transport {${TRANSPORTS.join(',')}}]
                    [--sse-host SSE_HOST] [--sse-port SSE_PORT]
                    [--streamable-http-host STREAMABLE_HTTP_HOST]
                    [--streamable-http-port STREAMABLE_HTTP_PORT]
                    [database_url]`;

const HELP = `${USAGE}

PostgreSQL MCP Server

positional arguments:
  database_url          Database connection URL

options:
  -h, --help            show this help message and exit
  --access-mode {${ACCESS_MODES.join(',')}}
                        Set SQL access mode: unrestricted (unrestricted) or
                        restricted (read-only with protections)
  --transport {${TRANSPORTS.join(',')}}
                        Select MCP transport: stdio (default), sse, or
                        streamable-http
  --sse-host SSE_HOST   Host to bind SSE server to (default: localhost)
  --sse-port SSE_PORT   Port for SSE server (default: 8000)
  --streamable-http-host STREAMABLE_HTTP_HOST
                        Host to bind streamable HTTP server to (default:
                        localhost)
  --streamable-http-port STREAMABLE_HTTP_PORT
                        Port for streamable HTTP server (default: 8000)
`;

function choice<T extends string>(flag: string, value: string | undefined, choices: readonly T[], fallback: T): T {
  if (value === undefined) {
    return fallback;
  }
  const match = choices.find((item) => item === value);
  if (!match) {
    throw new CliError(
      `argument ${flag}: invalid choice: '${value}' (choose from ${choices.map((c) => `'${c}'`).join(', ')})`
    );
  }
  return match;
}

const INT_PATTERN = /^[+-]?\d+$/u;

function parsePort(flag: string, value: string | undefined): number {
  if (value === undefined) {
    return 8000;
  }
  if (!INT_PATTERN.test(value.trim())) {
    throw new CliError(`argument ${flag}: invalid int value: '${value}'`);
  }
  return Number.parseInt(value, 10);
}

function parseRaw(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        'access-mode': { type: 'string' },
        transport: { type: 'string' },
        'sse-host': { type: 'string' },
        'sse-port': { type: 'string' },
        'streamable-http-host': { type: 'string' },
        'streamable-http-port': { type: 'string' },
      },
    });
  } catch (error) {
    throw new CliError(errorMessage(error), { cause: error });
  }
}

/** Parse the command line; returns null when help was requested. */
export function parseCli(argv: string[]): CliOptions | null {
  const { values, positionals } = parseRaw(argv);
  if (values.help) {
    return null;
  }
  if (positionals.length > 1) {
    throw new CliError(`unrecognized arguments: ${positionals.slice(1).join(' ')}`);
  }

  return {
    databaseUrl: positionals[0],
    accessMode: choice('--access-mode', values['access-mode'], ACCESS_MODES, AccessMode.UNRESTRICTED),
    transport: choice('--transport', values.transport, TRANSPORTS, 'stdio'),
    sseHost: values['sse-host'] ?? 'localhost',
    ssePort: parsePort('--sse-port', values['sse-port']),
    streamableHttpHost: values['streamable-http-host'] ?? 'localhost',
    streamableHttpPort: parsePort('--streamable-http-port', values['streamable-http-port']),
  };
}

let shutdownInProgress = false;

/** Clean shutdown of the server. */
export async function shutdown(signal?: NodeJS.Signals): Promise<void> {
  if (shutdownInProgress) {
    log('WARNING', 'Forcing immediate exit');
    process.exit(1);
  }
  shutdownInProgress = true;

  if (signal) {
    log('INFO', `Received exit signal ${signal}`);
  }

  try {
    await dbConnection.close();
    log('INFO', 'Closed database connections');
  } catch (error) {
    log('ERROR', `Error closing database connections: ${errorMessage(error)}`);
  }

  process.exit(signal ? 128 + (osConstants.signals[signal] ?? 0) : 0);
}

let signalHandlersInstalled = false;

function installSignalHandlers(): void {
  if (signalHandlersInstalled) {
    return;
  }
  signalHandlersInstalled = true;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }
}

export async function main(argv: string[]): Promise<void> {
  let options: CliOptions | null;
  try {
    options = parseCli(argv);
  } catch (error) {
    if (!(error instanceof CliError)) {
      throw error;
    }
    process.stderr.write(`${USAGE}\n${PROG}: error: ${error.message}\n`);
    process.exit(2);
  }
  if (options === null) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const { accessMode } = options;
  log('INFO', `Starting PostgreSQL MCP Server in ${accessMode.toUpperCase()} mode`);

  // Get database URL from environment variable or command line
  const databaseUrl = process.env.DATABASE_URI ?? options.databaseUrl;
  if (!databaseUrl) {
    throw new Error(
      "Error: No database URL provided. Please specify via 'DATABASE_URI' environment variable or command-line argument."
    );
  }

  // Initialize database connection pool
  try {
    await dbConnection.poolConnect(databaseUrl);
    log('INFO', 'Successfully connected to database and initialized connection pool');
  } catch (error) {
    log('WARNING', `Could not connect to database: ${obfuscatePassword(errorMessage(error))}`);
    log(
      'WARNING',
      'The MCP server will start but database operations will fail until a valid connection is established.'
    );
  }

  installSignalHandlers();

  if (options.transport === 'sse') {
    warnIfExposed(options.sseHost, accessMode);
  } else if (options.transport === 'streamable-http') {
    warnIfExposed(options.streamableHttpHost, accessMode);
  }

  const factory = () => createServer(accessMode);
  switch (options.transport) {
    case 'stdio': {
      await runners.runStdio(factory);
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
