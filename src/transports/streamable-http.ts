import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { errorMessage } from '../errors.ts';
import { log } from '../log.ts';
import type { ServerFactory } from '../server.ts';
import type { HttpServerHandle } from './http.ts';
import {
  closeHttpServer,
  headerValue,
  holdSession,
  listenGuarded,
  logCloseFailure,
  parseRequestUrl,
  readBody,
  sendBodyTooLarge,
  sendJsonRpcError,
} from './http.ts';
import type { HttpServerOptions } from './request-guard.ts';
import { SessionStore } from './sessions.ts';

type McpSessions = SessionStore<StreamableHTTPServerTransport>;

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
  store.add(id, transport);
  holdSession(store, id, res);
  let initialized = false;
  try {
    await createMcpServer().connect(transport);
    await transport.handleRequest(req, res, body);
    initialized = transport.sessionId === id && res.statusCode >= 200 && res.statusCode < 300;
  } finally {
    if (!initialized) {
      store.remove(id);
      transport.close().catch(logCloseFailure(`session ${id}`));
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
  const existing = sessionId ? store.get(sessionId) : undefined;
  if (sessionId && existing) {
    holdSession(store, sessionId, res);
  }

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

/** Serve MCP over streamable HTTP and resolve once listening. */
export async function startStreamableHttpServer(
  createMcpServer: ServerFactory,
  options: HttpServerOptions
): Promise<HttpServerHandle> {
  const store: McpSessions = new SessionStore(options);

  const { httpServer, port } = await listenGuarded('Streamable HTTP server', '/mcp', options, (req, res) => {
    const path = parseRequestUrl(req)?.pathname;
    if (path === undefined) {
      res.writeHead(400).end('Bad Request');
      return;
    }
    if (path !== '/mcp') {
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
  });
  return {
    port,
    close: async () => {
      await store.closeAll();
      await closeHttpServer(httpServer);
    },
  };
}
