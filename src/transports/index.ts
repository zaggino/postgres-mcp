import type { HttpServerOptions } from './request-guard.ts';
import { startSseServer } from './sse.ts';
import { runStdio } from './stdio.ts';
import { startStreamableHttpServer } from './streamable-http.ts';
import type { ServerFactory } from './types.ts';

/** Starts an HTTP transport; both HTTP transports share this contract. */
type HttpTransportStarter = (createMcpServer: ServerFactory, options: HttpServerOptions) => Promise<unknown>;

/** The transports `main` can start, keyed by their `--transport` value; tests pass stubs. */
export interface Transports {
  readonly stdio: (createMcpServer: ServerFactory, onClientGone: () => void) => Promise<unknown>;
  readonly sse: HttpTransportStarter;
  readonly 'streamable-http': HttpTransportStarter;
}

export const defaultTransports: Transports = {
  stdio: runStdio,
  sse: startSseServer,
  'streamable-http': startStreamableHttpServer,
};
