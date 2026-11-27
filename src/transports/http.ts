import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createHttpServer } from 'node:http';

import { log } from '../log.ts';
import type { HttpServerOptions } from './request-guard.ts';
import { guardRequests } from './request-guard.ts';

/** A running HTTP transport: the bound port and a way to stop it. */
export interface HttpServerHandle {
  close: () => Promise<void>;
  port: number;
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

export function parseRequestUrl(req: IncomingMessage): URL | null {
  try {
    return new URL(req.url ?? '/', 'http://localhost');
  } catch {
    return null;
  }
}

/**
 * Listens, then serves requests that pass the Host and Origin check. The handler
 * attaches after listening because the default allow-list names the bound port.
 * Closing the handle closes the sessions in `store`, then the HTTP server.
 */
export async function listenGuarded(
  label: string,
  path: string,
  options: HttpServerOptions,
  store: { closeAll: () => Promise<void> },
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<HttpServerHandle> {
  const httpServer = createHttpServer();
  const port = await listen(httpServer, options.host, options.port);
  httpServer.on('request', guardRequests(options, port, handler));
  log('INFO', `${label} listening on http://${options.host}:${port}${path}`);
  return {
    port,
    close: async () => {
      await store.closeAll();
      await closeHttpServer(httpServer);
    },
  };
}
