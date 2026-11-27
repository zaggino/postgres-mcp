import { readFileSync } from 'node:fs';
import { constants as osConstants } from 'node:os';

import { exitOnCliError, HELP, httpOptions, parseCli } from './cli.ts';
import { resolveConfig } from './config.ts';
import { DatabaseRegistry } from './database-registry.ts';
import { errorMessage } from './errors.ts';
import { log } from './log.ts';
import { createServer } from './server.ts';
import type { AccessMode } from './sql/driver-factory.ts';
import type { Transports } from './transports/index.ts';
import { defaultTransports } from './transports/index.ts';
import type { HttpServerOptions } from './transports/request-guard.ts';
import { LOOPBACK_HOSTS } from './transports/request-guard.ts';

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

function warnIfExposed(http: HttpServerOptions, accessMode: AccessMode): void {
  if (!LOOPBACK_HOSTS.has(http.host)) {
    const hostChecks = http.allowedHosts === 'any' ? ' Host checks are disabled by --allowed-hosts=*.' : '';
    log(
      'WARNING',
      `Listening on ${http.host}: the server is reachable from the network with no authentication.${hostChecks} Anyone who can connect can run queries in ${accessMode.toUpperCase()} mode.`
    );
  }
}

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

  const factory = () => createServer(registry);
  if (options.transport === 'stdio') {
    await transports.stdio(factory, () => {
      void shutdown(registry);
    });
    return;
  }

  const http = httpOptions(options);
  if (http === undefined) {
    throw new Error(`No HTTP options for transport ${options.transport}`);
  }
  warnIfExposed(http, accessMode);
  await transports[options.transport](factory, http);
}
