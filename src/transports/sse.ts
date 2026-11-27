/* oxlint-disable typescript/no-deprecated -- the SSE transport is part of the upstream CLI surface */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

import { errorMessage } from '../errors.ts';
import { log } from '../log.ts';
import type { HttpServerHandle } from './http.ts';
import { listenGuarded, logCloseFailure, parseRequestUrl } from './http.ts';
import type { HttpServerOptions } from './request-guard.ts';
import { SessionStore } from './sessions.ts';
import type { ServerFactory } from './types.ts';

const SSE_SESSION_PARAM = 'sessionId';

type SseSessions = SessionStore<SSEServerTransport>;

async function handleSseRequest(
  createMcpServer: ServerFactory,
  store: SseSessions,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = parseRequestUrl(req);
  if (!url) {
    res.writeHead(400).end('Bad Request');
    return;
  }
  const path = url.pathname;
  if (req.method === 'GET' && path === '/sse') {
    if (store.full) {
      res.writeHead(503).end('Too many sessions');
      return;
    }
    const transport = new SSEServerTransport('/messages', res);
    const mcpServer = createMcpServer();
    store.add(transport.sessionId, transport);
    res.on('close', () => {
      store.remove(transport.sessionId);
      mcpServer.close().catch(logCloseFailure(`SSE session ${transport.sessionId}`));
    });
    await mcpServer.connect(transport);
    return;
  }
  if (req.method === 'POST' && path === '/messages') {
    const sessionId = url.searchParams.get(SSE_SESSION_PARAM);
    const transport = sessionId ? store.get(sessionId) : undefined;
    if (!transport) {
      res.writeHead(sessionId ? 404 : 400).end('Could not find session');
      return;
    }
    await transport.handlePostMessage(req, res);
    return;
  }
  res.writeHead(404).end('Not Found');
}

/** Serve MCP over SSE and resolve once listening. */
export async function startSseServer(
  createMcpServer: ServerFactory,
  options: HttpServerOptions
): Promise<HttpServerHandle> {
  const store: SseSessions = new SessionStore<SSEServerTransport>(options);

  return await listenGuarded('SSE server', '/sse', options, store, (req, res) => {
    handleSseRequest(createMcpServer, store, req, res).catch((error: unknown) => {
      log('ERROR', `SSE request failed: ${errorMessage(error)}`);
      if (!res.headersSent) {
        res.writeHead(500).end('Internal Server Error');
      }
    });
  });
}
