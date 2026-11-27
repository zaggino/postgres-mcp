import type { HttpServerOptions } from './request-guard.ts';
import { startSseServer } from './sse.ts';
import { runStdio } from './stdio.ts';
import { startStreamableHttpServer } from './streamable-http.ts';
import type { ServerFactory } from './types.ts';

/** The transports `main` can start, keyed by their `--transport` value; tests pass stubs. */
export interface Transports {
  stdio: (createMcpServer: ServerFactory, onClientGone: () => void) => Promise<unknown>;
  sse: (createMcpServer: ServerFactory, options: HttpServerOptions) => Promise<unknown>;
  'streamable-http': (createMcpServer: ServerFactory, options: HttpServerOptions) => Promise<unknown>;
}

export const defaultTransports: Transports = {
  stdio: runStdio,
  sse: startSseServer,
  'streamable-http': startStreamableHttpServer,
};
