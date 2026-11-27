import { readFileSync } from 'node:fs';
import { constants as osConstants } from 'node:os';

import { exitOnCliError, HELP, httpOptions, parseCli } from './cli.ts';
import { resolveConfig } from './config.ts';
import { DatabaseRegistry } from './database-registry.ts';
import { errorMessage } from './errors.ts';
import { log } from './log.ts';
import type { ServerFactory } from './server.ts';
import { createServer } from './server.ts';
import { warnIfExposed } from './transports/http.ts';
import type { HttpServerOptions } from './transports/request-guard.ts';
import { startSseServer } from './transports/sse.ts';
import { runStdio } from './transports/stdio.ts';
import { startStreamableHttpServer } from './transports/streamable-http.ts';

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

/** The transports `main` starts; tests pass stubs. */
export interface Transports {
  runStdio: (createMcpServer: ServerFactory, onClientGone: () => void) => Promise<void>;
  runSse: (createMcpServer: ServerFactory, options: HttpServerOptions) => Promise<void>;
  runStreamableHttp: (createMcpServer: ServerFactory, options: HttpServerOptions) => Promise<void>;
}

const defaultTransports: Transports = {
  runStdio,
  runSse: async (createMcpServer, options) => {
    await startSseServer(createMcpServer, options);
  },
  runStreamableHttp: async (createMcpServer, options) => {
    await startStreamableHttpServer(createMcpServer, options);
  },
};

export async function main(argv: string[], transports: Transports = defaultTransports): Promise<void> {
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
    await transports.runStdio(factory, () => {
      void shutdown(registry);
    });
  } else if (options.transport === 'sse') {
    await transports.runSse(factory, http);
  } else {
    await transports.runStreamableHttp(factory, http);
  }
}
