import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createHttpServer } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { errorMessage } from '../errors.ts';
import { log } from '../log.ts';
import type { HttpServerHandle } from './http.ts';
import { closeHttpServer, listen, parseRequestUrl } from './http.ts';
import type { HttpServerOptions } from './request-guard.ts';
import { guardRequests } from './request-guard.ts';
import { SessionStore } from './sessions.ts';
import type { ServerFactory } from './types.ts';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MCP_PATH = '/mcp';

type McpSessions = SessionStore<StreamableHTTPServerTransport>;

function readBody(req: IncomingMessage): Promise<unknown> {
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

function sendJsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  if (res.headersSent) {
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

function sendBodyTooLarge(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('Connection', 'close');
  sendJsonRpcError(res, 413, -32_600, 'Request body too large');
  res.once('finish', () => {
    req.destroy();
  });
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function startMcpSession(
  createMcpServer: ServerFactory,
  store: McpSessions,
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown
): Promise<void> {
  // The id is chosen up front so the session counts against the cap before the first await.
  const id = randomUUID();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => id });
  transport.onclose = () => {
    store.remove(id);
  };
  store.add(id, transport, res);
  let initialized = false;
  try {
    await createMcpServer().connect(transport);
    await transport.handleRequest(req, res, body);
    initialized = transport.sessionId === id && res.statusCode >= 200 && res.statusCode < 300;
  } finally {
    if (!initialized) {
      store.close(id, transport);
    }
  }
}

async function handleMcpRequest(
  createMcpServer: ServerFactory,
  store: McpSessions,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const sessionId = headerValue(req, 'mcp-session-id');
  const existing = sessionId ? store.acquire(sessionId, res) : undefined;

  if (req.method === 'POST') {
    const body = await readBody(req);
    if (existing) {
      await existing.handleRequest(req, res, body);
    } else if (!sessionId && isInitializeRequest(body)) {
      if (store.full) {
        sendJsonRpcError(res, 503, -32_000, 'Too many sessions');
        return;
      }
      await startMcpSession(createMcpServer, store, req, res, body);
    } else {
      sendMissingSession(res, sessionId);
    }
    return;
  }

  if (req.method === 'GET' || req.method === 'DELETE') {
    if (existing) {
      await existing.handleRequest(req, res);
    } else {
      sendMissingSession(res, sessionId);
    }
    return;
  }

  res.writeHead(405, { Allow: 'GET, POST, DELETE' }).end();
}

function sendMissingSession(res: ServerResponse, sessionId: string | undefined): void {
  if (sessionId) {
    sendJsonRpcError(res, 404, -32_000, 'Session not found');
  } else {
    sendJsonRpcError(res, 400, -32_000, 'Bad Request: No valid session ID provided');
  }
}

function routeRequest(
  createMcpServer: ServerFactory,
  store: McpSessions,
  req: IncomingMessage,
  res: ServerResponse
): void {
  const path = parseRequestUrl(req)?.pathname;
  if (path === undefined) {
    res.writeHead(400).end('Bad Request');
    return;
  }
  if (path !== MCP_PATH) {
    res.writeHead(404).end('Not Found');
    return;
  }
  handleMcpRequest(createMcpServer, store, req, res).catch((error: unknown) => {
    log('ERROR', `Streamable HTTP request failed: ${errorMessage(error)}`);
    if (error instanceof RangeError) {
      sendBodyTooLarge(req, res);
      return;
    }
    const badJson = error instanceof SyntaxError;
    sendJsonRpcError(
      res,
      badJson ? 400 : 500,
      badJson ? -32_700 : -32_603,
      badJson ? 'Parse error' : 'Internal server error'
    );
  });
}

/**
 * Serve MCP over streamable HTTP and resolve once listening. Every request must pass the Host and Origin check,
 * which attaches after listening because the default allow-list names the bound port. Closing the handle closes
 * the sessions, then the HTTP server.
 */
export async function startStreamableHttpServer(
  createMcpServer: ServerFactory,
  options: HttpServerOptions
): Promise<HttpServerHandle> {
  const store: McpSessions = new SessionStore(options);
  const httpServer = createHttpServer();
  const port = await listen(httpServer, options.host, options.port);
  httpServer.on(
    'request',
    guardRequests(options, port, (req, res) => {
      routeRequest(createMcpServer, store, req, res);
    })
  );
  log('INFO', `Streamable HTTP server listening on http://${options.host}:${port}${MCP_PATH}`);
  return {
    port,
    close: async () => {
      await store.closeAll();
      await closeHttpServer(httpServer);
    },
  };
}
