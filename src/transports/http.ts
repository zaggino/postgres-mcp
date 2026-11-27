import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createHttpServer } from 'node:http';

import { errorMessage } from '../errors.ts';
import { log } from '../log.ts';
import type { HttpServerOptions } from './request-guard.ts';
import { guardRequests, LOOPBACK_HOSTS } from './request-guard.ts';
import type { SessionStore } from './sessions.ts';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** A running HTTP transport: the bound port and a way to stop it. */
export interface HttpServerHandle {
  close: () => Promise<void>;
  port: number;
}

export function warnIfExposed(http: HttpServerOptions, accessMode: string): void {
  if (!LOOPBACK_HOSTS.has(http.host)) {
    const hostChecks = http.allowedHosts === 'any' ? ' Host checks are disabled by --allowed-hosts=*.' : '';
    log(
      'WARNING',
      `Listening on ${http.host}: the server is reachable from the network with no authentication.${hostChecks} Anyone who can connect can run queries in ${accessMode.toUpperCase()} mode.`
    );
  }
}

export function readBody(req: IncomingMessage): Promise<unknown> {
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

export function sendJsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  if (res.headersSent) {
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

export function sendBodyTooLarge(req: IncomingMessage, res: ServerResponse): void {
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

export function closeHttpServer(httpServer: ReturnType<typeof createHttpServer>): Promise<void> {
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

export function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function logCloseFailure(what: string): (error: unknown) => void {
  return (error) => {
    log('ERROR', `Error closing ${what}: ${errorMessage(error)}`);
  };
}

/** Keeps the session's idle timer stopped until the response closes. */
export function holdSession<T extends { close: () => Promise<void> }>(
  store: SessionStore<T>,
  id: string,
  res: ServerResponse
): void {
  store.begin(id);
  res.once('close', () => {
    store.end(id);
  });
}

/**
 * Listens, then serves requests that pass the Host and Origin check. The handler
 * attaches after listening because the default allow-list names the bound port.
 */
export async function listenGuarded(
  label: string,
  path: string,
  options: HttpServerOptions,
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ httpServer: ReturnType<typeof createHttpServer>; port: number }> {
  const httpServer = createHttpServer();
  const port = await listen(httpServer, options.host, options.port);
  httpServer.on('request', guardRequests(options, port, handler));
  log('INFO', `${label} listening on http://${options.host}:${port}${path}`);
  return { httpServer, port };
}
