import { parseArgs } from 'node:util';

import type { AccessMode } from './sql/driver-factory.ts';
import { ACCESS_MODES } from './sql/driver-factory.ts';

export class CliError extends Error {}

/** The longest delay setTimeout accepts (2^31 - 1 ms); larger values would fire at once. */
export const MAX_IDLE_MINUTES = Math.floor((2 ** 31 - 1) / 60_000);

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
  transport: Transport;
}

const PROG = 'postgres-mcp';
const USAGE = `usage: ${PROG} [-h] [--access-mode {${ACCESS_MODES.join(',')}}]
                    [--transport {${TRANSPORTS.join(',')}}]
                    [--sse-host SSE_HOST] [--sse-port SSE_PORT]
                    [--streamable-http-host STREAMABLE_HTTP_HOST]
                    [--streamable-http-port STREAMABLE_HTTP_PORT]
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

  return {
    accessMode: choice('--access-mode', values['access-mode'], ACCESS_MODES),
    databases: values.database ?? [],
    configPath: values.config,
    idleMinutes: parseIdleMinutes(values['idle-minutes']),
    transport: choice('--transport', values.transport, TRANSPORTS) ?? 'stdio',
    sseHost: values['sse-host'] ?? 'localhost',
    ssePort: parsePort('--sse-port', values['sse-port']),
    streamableHttpHost: values['streamable-http-host'] ?? 'localhost',
    streamableHttpPort: parsePort('--streamable-http-port', values['streamable-http-port']),
  };
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
