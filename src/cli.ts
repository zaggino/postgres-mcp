import { parseArgs } from 'node:util';

import type { AccessMode } from './sql/driver-factory.ts';
import { ACCESS_MODES } from './sql/driver-factory.ts';

export class CliError extends Error {}

/** The longest delay setTimeout accepts (2^31 - 1 ms); larger values would fire at once. */
export const MAX_IDLE_MINUTES = Math.floor((2 ** 31 - 1) / 60_000);

export const DEFAULT_MAX_SESSIONS = 100;
export const DEFAULT_SESSION_IDLE_MINUTES = 30;

const TRANSPORTS = ['stdio', 'sse', 'streamable-http'] as const;
export type Transport = (typeof TRANSPORTS)[number];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface CliOptions {
  accessMode: AccessMode | undefined;
  databases: string[];
  configPath: string | undefined;
  idleMinutes: number | undefined;
  sseHost: string;
  ssePort: number;
  streamableHttpHost: string;
  streamableHttpPort: number;
  allowedHosts: string[] | undefined;
  allowedOrigins: string[] | undefined;
  maxSessions: number;
  sessionIdleMinutes: number;
  transport: Transport;
}

/** Hosts a server can bind to without being reachable from the network. */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1']);

const PROG = 'postgres-mcp';
const USAGE = `usage: ${PROG} [-h] [--access-mode {${ACCESS_MODES.join(',')}}]
                    [--transport {${TRANSPORTS.join(',')}}]
                    [--sse-host SSE_HOST] [--sse-port SSE_PORT]
                    [--streamable-http-host STREAMABLE_HTTP_HOST]
                    [--streamable-http-port STREAMABLE_HTTP_PORT]
                    [--allowed-hosts HOSTS] [--allowed-origins ORIGINS]
                    [--max-sessions N] [--session-idle-minutes N]
                    [--database NAME] [--config FILE] [--idle-minutes N]`;

export const HELP = `${USAGE}

PostgreSQL MCP Server

options:
  -h, --help            show this help message and exit
  --access-mode {${ACCESS_MODES.join(',')}}
                        Set SQL access mode: unrestricted (unrestricted) or
                        restricted (read-only with protections)
  --database NAME       Database to serve; repeatable. The connection URI is
                        read from MCP_<NAME>_DATABASE_URI (name uppercased,
                        '-' becomes '_'). Exclusive with --config
  --config FILE         JSON config file naming databases and servers to
                        discover databases on. Exclusive with --database
  --idle-minutes N      Close a database's pool after N idle minutes
                        (default: 10, 0 = never)
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
  --allowed-hosts HOSTS
                        Comma-separated Host header values the HTTP transports
                        accept, in addition to loopback on a loopback bind. An
                        entry without a port matches any port; '*' accepts any
                        Host. Required when the bind host is not loopback
  --allowed-origins ORIGINS
                        Comma-separated Origin header values (scheme://host[:port])
                        the HTTP transports accept; '*' accepts any Origin.
                        Requests without an Origin header are not checked.
                        Default: loopback origins on a loopback bind, none
                        otherwise
  --max-sessions N      Most concurrent sessions the HTTP transports hold;
                        further ones get 503 (default: ${DEFAULT_MAX_SESSIONS})
  --session-idle-minutes N
                        Close an HTTP session after N minutes without a request
                        (default: ${DEFAULT_SESSION_IDLE_MINUTES}, 0 = never)
`;

/** The matching choice, or `undefined` when the flag is absent. */
function choice<T extends string>(flag: string, value: string | undefined, choices: readonly T[]): T | undefined {
  if (value === undefined) {
    return undefined;
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

function parseIdleMinutes(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!INT_PATTERN.test(value.trim())) {
    throw new CliError(`argument --idle-minutes: invalid int value: '${value}'`);
  }
  const minutes = Number.parseInt(value, 10);
  if (minutes < 0 || minutes > MAX_IDLE_MINUTES) {
    throw new CliError(`argument --idle-minutes: must be between 0 and ${MAX_IDLE_MINUTES}: '${value}'`);
  }
  return minutes;
}

function parseMaxSessions(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_SESSIONS;
  }
  if (!INT_PATTERN.test(value.trim())) {
    throw new CliError(`argument --max-sessions: invalid int value: '${value}'`);
  }
  const sessions = Number.parseInt(value, 10);
  if (sessions < 1 || !Number.isSafeInteger(sessions)) {
    throw new CliError(`argument --max-sessions: must be at least 1: '${value}'`);
  }
  return sessions;
}

function parseSessionIdleMinutes(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_SESSION_IDLE_MINUTES;
  }
  if (!INT_PATTERN.test(value.trim())) {
    throw new CliError(`argument --session-idle-minutes: invalid int value: '${value}'`);
  }
  const minutes = Number.parseInt(value, 10);
  if (minutes < 0 || minutes > MAX_IDLE_MINUTES) {
    throw new CliError(`argument --session-idle-minutes: must be between 0 and ${MAX_IDLE_MINUTES}: '${value}'`);
  }
  return minutes;
}

/** The comma-separated entries, `undefined` when the flag is absent. */
function parseList(flag: string, value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.some((entry) => entry === '')) {
    throw new CliError(`argument ${flag}: empty entry in '${value}'`);
  }
  return entries;
}

function requireAllowedHosts(options: CliOptions): void {
  let host: string;
  if (options.transport === 'sse') {
    host = options.sseHost;
  } else if (options.transport === 'streamable-http') {
    host = options.streamableHttpHost;
  } else {
    return;
  }
  if (!LOOPBACK_HOSTS.has(host) && options.allowedHosts === undefined) {
    throw new CliError(
      `binding ${host} exposes the server to the network: pass --allowed-hosts with the Host header values clients use (or --allowed-hosts='*' to accept any Host)`
    );
  }
}

function parseRaw(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        'access-mode': { type: 'string' },
        database: { type: 'string', multiple: true },
        config: { type: 'string' },
        'idle-minutes': { type: 'string' },
        transport: { type: 'string' },
        'sse-host': { type: 'string' },
        'sse-port': { type: 'string' },
        'streamable-http-host': { type: 'string' },
        'streamable-http-port': { type: 'string' },
        'allowed-hosts': { type: 'string' },
        'allowed-origins': { type: 'string' },
        'max-sessions': { type: 'string' },
        'session-idle-minutes': { type: 'string' },
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
  if (positionals.length > 0) {
    throw new CliError(`unrecognized arguments: ${positionals.join(' ')}`);
  }

  const options: CliOptions = {
    accessMode: choice('--access-mode', values['access-mode'], ACCESS_MODES),
    databases: values.database ?? [],
    configPath: values.config,
    idleMinutes: parseIdleMinutes(values['idle-minutes']),
    transport: choice('--transport', values.transport, TRANSPORTS) ?? 'stdio',
    sseHost: values['sse-host'] ?? 'localhost',
    ssePort: parsePort('--sse-port', values['sse-port']),
    streamableHttpHost: values['streamable-http-host'] ?? 'localhost',
    streamableHttpPort: parsePort('--streamable-http-port', values['streamable-http-port']),
    allowedHosts: parseList('--allowed-hosts', values['allowed-hosts']),
    allowedOrigins: parseList('--allowed-origins', values['allowed-origins']),
    maxSessions: parseMaxSessions(values['max-sessions']),
    sessionIdleMinutes: parseSessionIdleMinutes(values['session-idle-minutes']),
  };
  requireAllowedHosts(options);
  return options;
}

export function exitOnCliError<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (!(error instanceof CliError)) {
      throw error;
    }
    process.stderr.write(`${USAGE}\n${PROG}: error: ${error.message}\n`);
    return process.exit(2);
  }
}
