import { request } from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, expect, it as test, vi } from 'vitest';

import type { HttpServerHandle, HttpServerOptions } from '../../src/server.ts';
import { createServer, startSseServer, startStreamableHttpServer } from '../../src/server.ts';
import { createTestRegistry } from '../support/registry.ts';

const HOST = '127.0.0.1';
const TOOL_COUNT = 10;

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  vi.restoreAllMocks();
});

function factory() {
  return createServer(createTestRegistry(['app']).registry);
}

async function startStreamable(options: Partial<HttpServerOptions> = {}): Promise<HttpServerHandle> {
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const handle = await startStreamableHttpServer(factory, { host: HOST, port: 0, ...options });
  cleanups.push(handle.close);
  return handle;
}

async function startSse(options: Partial<HttpServerOptions> = {}): Promise<HttpServerHandle> {
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const handle = await startSseServer(factory, { host: HOST, port: 0, ...options });
  cleanups.push(handle.close);
  return handle;
}

// oxlint-disable-next-line typescript/no-deprecated -- the server still offers the SSE transport
async function listToolsThrough(client: Client, transport: SSEClientTransport | StreamableHTTPClientTransport) {
  cleanups.push(() => client.close());
  await client.connect(transport);
  return (await client.listTools()).tools;
}

/** Status of a raw request, so the Host header and the request target stay under control. */
function statusOf(
  port: number,
  options: { body?: string; headers?: Record<string, string>; method: string },
  path: string
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: HOST,
        port,
        path,
        method: options.method,
        headers: options.headers,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'raw-client', version: '0.0.0' },
  },
});

test('streamable HTTP serves the ten tools to the SDK client', async () => {
  const { port } = await startStreamable();

  const tools = await listToolsThrough(
    new Client({ name: 'test-client', version: '0.0.0' }),
    new StreamableHTTPClientTransport(new URL(`http://${HOST}:${port}/mcp`))
  );

  expect(tools).toHaveLength(TOOL_COUNT);
});

test('SSE serves the ten tools to the SDK client', async () => {
  const { port } = await startSse();

  const tools = await listToolsThrough(
    new Client({ name: 'test-client', version: '0.0.0' }),
    // oxlint-disable-next-line typescript/no-deprecated -- the server still offers the SSE transport
    new SSEClientTransport(new URL(`http://${HOST}:${port}/sse`))
  );

  expect(tools).toHaveLength(TOOL_COUNT);
});

test('a malformed request target gets a 400 and the server keeps serving', async () => {
  const { port } = await startStreamable();

  const status = await statusOf(port, { method: 'GET' }, '//');
  const tools = await listToolsThrough(
    new Client({ name: 'test-client', version: '0.0.0' }),
    new StreamableHTTPClientTransport(new URL(`http://${HOST}:${port}/mcp`))
  );

  expect(status).toBe(400);
  expect(tools).toHaveLength(TOOL_COUNT);
});

test('a foreign Host header is rejected with 403 on /mcp', async () => {
  const { port } = await startStreamable();

  const status = await statusOf(
    port,
    {
      method: 'POST',
      body: INITIALIZE,
      headers: {
        Host: 'evil.example',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
    },
    '/mcp'
  );

  expect(status).toBe(403);
});

test('a foreign Host header is rejected with 403 on GET /sse', async () => {
  const { port } = await startSse();

  const status = await statusOf(port, { method: 'GET', headers: { Host: 'evil.example' } }, '/sse');

  expect(status).toBe(403);
});

test('a Host header outside --allowed-hosts is rejected and a listed one is accepted, port optional', async () => {
  const { port } = await startSse({ allowedHosts: ['example.test'] });
  const post = (host: string) => statusOf(port, { method: 'POST', headers: { Host: host } }, '/messages');

  await expect(post('evil.test')).resolves.toBe(403);
  await expect(post(`Example.Test:${port}`)).resolves.toBe(400);
});

test('a foreign Origin header is rejected and the server own origin is accepted', async () => {
  const { port } = await startSse();
  const post = (origin: string) => statusOf(port, { method: 'POST', headers: { Origin: origin } }, '/messages');

  await expect(post('http://evil.example')).resolves.toBe(403);
  await expect(post(`http://${HOST}:${port}`)).resolves.toBe(400);
});

test('POST /messages with a foreign Host header is rejected with 403', async () => {
  const { port } = await startSse();

  const status = await statusOf(port, { method: 'POST', headers: { Host: 'evil.example' } }, '/messages');

  expect(status).toBe(403);
});

test('--allowed-origins and --allowed-hosts set to * accept any Origin and Host', async () => {
  const { port } = await startSse({ allowedHosts: ['*'], allowedOrigins: ['*'] });

  const status = await statusOf(
    port,
    { method: 'POST', headers: { Host: 'anything.test', Origin: 'http://anything.test' } },
    '/messages'
  );

  expect(status).toBe(400);
});

const MCP_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

/** Raw `initialize` against /mcp: the status and the session id the server assigned. */
function initializeSession(port: number): Promise<{ sessionId: string | undefined; status: number }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: HOST, port, path: '/mcp', method: 'POST', headers: MCP_HEADERS }, (res) => {
      res.resume();
      const id = res.headers['mcp-session-id'];
      resolve({ status: res.statusCode ?? 0, sessionId: Array.isArray(id) ? id[0] : id });
    });
    req.on('error', reject);
    req.end(INITIALIZE);
  });
}

test('streamable HTTP refuses an initialize beyond --max-sessions with 503', async () => {
  const { port } = await startStreamable({ maxSessions: 1 });

  const first = await initializeSession(port);
  const second = await initializeSession(port);

  expect(first.status).toBe(200);
  expect(second.status).toBe(503);
});

test('SSE refuses GET /sse beyond --max-sessions with 503', async () => {
  const { port } = await startSse({ maxSessions: 1 });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  // oxlint-disable-next-line typescript/no-deprecated -- the server still offers the SSE transport
  await listToolsThrough(client, new SSEClientTransport(new URL(`http://${HOST}:${port}/sse`)));

  const status = await statusOf(port, { method: 'GET' }, '/sse');

  expect(status).toBe(503);
});

test('a streamable HTTP session idle past --session-idle-minutes is closed and its id gets 404', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  cleanups.push(() => {
    vi.useRealTimers();
    return Promise.resolve();
  });
  const { port } = await startStreamable({ sessionIdleMinutes: 1 });
  const { sessionId } = await initializeSession(port);
  const post = () =>
    statusOf(
      port,
      { method: 'POST', body: '{}', headers: { ...MCP_HEADERS, 'Mcp-Session-Id': sessionId ?? '' } },
      '/mcp'
    );

  await vi.advanceTimersByTimeAsync(30_000);
  const requestResetsTimer = await post();
  await vi.advanceTimersByTimeAsync(45_000);
  const stillOpen = await post();
  await vi.advanceTimersByTimeAsync(60_001);
  const expired = await post();

  expect(sessionId).toBeTruthy();
  expect(requestResetsTimer).not.toBe(404);
  expect(stillOpen).not.toBe(404);
  expect(expired).toBe(404);
});
