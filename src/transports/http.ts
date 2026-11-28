import type { IncomingMessage, Server } from 'node:http';

/** A running HTTP transport: the bound port and a way to stop it. */
export interface HttpServerHandle {
  close: () => Promise<void>;
  port: number;
}

/** Starts listening and resolves with the port the OS actually bound. */
export function listen(httpServer: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject);
      const address = httpServer.address();
      resolve(typeof address === 'object' && address ? address.port : port);
    });
  });
}

export function closeHttpServer(httpServer: Server): Promise<void> {
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
