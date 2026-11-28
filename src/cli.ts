import { parseArgs } from 'node:util';

import { MAX_IDLE_MINUTES } from './database-registry.ts';
import { errorMessage } from './errors.ts';
import { logLine } from './log.ts';
import type { AccessMode } from './sql/driver-factory.ts';
import { ACCESS_MODES, DEFAULT_ACCESS_MODE, MAX_STATEMENT_TIMEOUT_SECONDS } from './sql/driver-factory.ts';
import type { AllowList, HttpServerOptions } from './transports/request-guard.ts';
import { hostEntryProblem, LOOPBACK_HOSTS, originEntryProblem } from './transports/request-guard.ts';
import { DEFAULT_MAX_SESSIONS, DEFAULT_SESSION_IDLE_MINUTES } from './transports/sessions.ts';

export class CliError extends Error {}

const TRANSPORTS = ['stdio', 'streamable-http'] as const;
export type Transport = (typeof TRANSPORTS)[number];

export interface CliOptions {
  accessMode: AccessMode | undefined;
  databases: string[];
  configPath: string | undefined;
  idleMinutes: number | undefined;
  statementTimeoutSeconds: number | undefined;
  /** The streamable HTTP transport's options; session limits and allow-lists default where they are used. */
  http: HttpServerOptions;
  transport: Transport;
}

const PROG = 'postgres-mcp';
const USAGE = `usage: ${PROG} [-h] [--access-mode {${ACCESS_MODES.join(',')}}]
                    [--transport {${TRANSPORTS.join(',')}}]
                    [--streamable-http-host STREAMABLE_HTTP_HOST]
                    [--streamable-http-port STREAMABLE_HTTP_PORT]
                    [--allowed-hosts HOSTS] [--allowed-origins ORIGINS]
                    [--max-sessions N] [--session-idle-minutes N]
                    [--database NAME] [--config FILE] [--idle-minutes N]
                    [--statement-timeout SECONDS]`;

export const HELP = `${USAGE}

PostgreSQL MCP Server

options:
  -h, --help            show this help message and exit
  --access-mode {${ACCESS_MODES.join(',')}}
                        Set SQL access mode: unrestricted or restricted
                        (read-only with protections) (default:
                        ${DEFAULT_ACCESS_MODE})
  --database NAME       Database to serve; repeatable. The connection URI is
                        read from MCP_<NAME>_DATABASE_URI (name uppercased,
                        '-' becomes '_'). Exclusive with --config
  --config FILE         JSONC config file naming databases and servers to
                        discover databases on. Exclusive with --database
  --idle-minutes N      Close a database's pool after N idle minutes
                        (default: 10, 0 = never)
  --statement-timeout SECONDS
                        Cancel a statement in Postgres after SECONDS
                        (default: 30 in restricted mode, 0 = none in
                        unrestricted mode; 0 = no timeout)
  --transport {${TRANSPORTS.join(',')}}
                        Select MCP transport: stdio (default) or
                        streamable-http
  --streamable-http-host STREAMABLE_HTTP_HOST
                        Host to bind streamable HTTP server to (default:
                        localhost)
  --streamable-http-port STREAMABLE_HTTP_PORT
                        Port for streamable HTTP server (default: 8000)
  --allowed-hosts HOSTS
                        Comma-separated Host header values the HTTP transport
                        accepts, in addition to loopback on a loopback bind. An
                        entry without a port matches any port; '*' accepts any
                        Host. Write IPv6 addresses in brackets. Required when
                        the bind host is not loopback
  --allowed-origins ORIGINS
                        Comma-separated Origin header values (scheme://host[:port])
                        the HTTP transport accepts, in addition to loopback on a
                        loopback bind; '*' accepts any Origin. Requests without
                        an Origin header are not checked
  --max-sessions N      Most concurrent sessions the HTTP transport holds;
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

const DEFAULT_PORT = 8000;
const INT_PATTERN = /^[+-]?\d+$/u;

function rangeText(range: { max?: number; min?: number }): string {
  const { min, max } = range;
  if (min !== undefined && max !== undefined) {
    return `must be between ${min} and ${max}`;
  }
  if (min !== undefined) {
    return `must be at least ${min}`;
  }
  if (max !== undefined) {
    return `must be at most ${max}`;
  }
  return 'must be a safe integer';
}

/** The integer value of a flag within `range`, or `undefined` when the flag is absent. */
function parseIntFlag(
  flag: string,
  value: string | undefined,
  range: { max?: number; min?: number } = {}
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!INT_PATTERN.test(value.trim())) {
    throw new CliError(`argument ${flag}: invalid int value: '${value}'`);
  }
  const parsed = Number.parseInt(value, 10);
  if (
    !Number.isSafeInteger(parsed) ||
    (range.min !== undefined && parsed < range.min) ||
    (range.max !== undefined && parsed > range.max)
  ) {
    throw new CliError(`argument ${flag}: ${rangeText(range)}: '${value}'`);
  }
  return parsed;
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

/** `'*'` alone becomes `'any'`; every other entry must pass `problemWith`. */
function parseAllowList(
  flag: string,
  value: string | undefined,
  problemWith: (entry: string) => string | null
): AllowList | undefined {
  const entries = parseList(flag, value);
  if (entries === undefined) {
    return undefined;
  }
  if (entries.includes('*')) {
    if (entries.length > 1) {
      throw new CliError(`argument ${flag}: '*' cannot be combined with other entries: '${value}'`);
    }
    return 'any';
  }
  for (const entry of entries) {
    const problem = problemWith(entry);
    if (problem !== null) {
      throw new CliError(`argument ${flag}: ${problem}: '${entry}'`);
    }
  }
  return entries;
}

function requireAllowedHosts(options: CliOptions): void {
  if (options.transport === 'stdio') {
    return;
  }
  const { http } = options;
  if (!LOOPBACK_HOSTS.has(http.host) && http.allowedHosts === undefined) {
    throw new CliError(
      `binding ${http.host} exposes the server to the network: pass --allowed-hosts with the Host header values clients use (or --allowed-hosts='*' to accept any Host)`
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
        'statement-timeout': { type: 'string' },
        transport: { type: 'string' },
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
    idleMinutes: parseIntFlag('--idle-minutes', values['idle-minutes'], { min: 0, max: MAX_IDLE_MINUTES }),
    statementTimeoutSeconds: parseIntFlag('--statement-timeout', values['statement-timeout'], {
      min: 0,
      max: MAX_STATEMENT_TIMEOUT_SECONDS,
    }),
    transport: choice('--transport', values.transport, TRANSPORTS) ?? 'stdio',
    http: {
      host: values['streamable-http-host'] ?? 'localhost',
      port: parseIntFlag('--streamable-http-port', values['streamable-http-port']) ?? DEFAULT_PORT,
      allowedHosts: parseAllowList('--allowed-hosts', values['allowed-hosts'], hostEntryProblem),
      allowedOrigins: parseAllowList('--allowed-origins', values['allowed-origins'], originEntryProblem),
      maxSessions: parseIntFlag('--max-sessions', values['max-sessions'], { min: 1 }),
      sessionIdleMinutes: parseIntFlag('--session-idle-minutes', values['session-idle-minutes'], {
        min: 0,
        max: MAX_IDLE_MINUTES,
      }),
    },
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
    logLine(`${USAGE}\n${PROG}: error: ${error.message}`);
    return process.exit(2);
  }
}
