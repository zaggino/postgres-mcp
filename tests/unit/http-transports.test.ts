import { request } from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, expect, it as test, vi } from 'vitest';

import { createServer } from '../../src/server.ts';
import type { HttpServerHandle } from '../../src/transports/http.ts';
import type { HttpServerOptions } from '../../src/transports/request-guard.ts';
import { startStreamableHttpServer } from '../../src/transports/streamable-http.ts';
import { createTestRegistry } from '../support/registry.ts';

const HOST = '127.0.0.1';
const TOOL_COUNT = 11;

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

async function listToolsThrough(client: Client, transport: StreamableHTTPClientTransport) {
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

const MCP_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

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

test(`streamable HTTP serves the ${TOOL_COUNT} tools to the SDK client`, async () => {
  const { port } = await startStreamable();

  const tools = await listToolsThrough(
    new Client({ name: 'test-client', version: '0.0.0' }),
    new StreamableHTTPClientTransport(new URL(`http://${HOST}:${port}/mcp`))
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
    { method: 'POST', body: INITIALIZE, headers: { ...MCP_HEADERS, Host: 'evil.example' } },
    '/mcp'
  );

  expect(status).toBe(403);
});

test('a Host header outside --allowed-hosts is rejected and a listed one is accepted, port optional', async () => {
  const { port } = await startStreamable({ allowedHosts: ['example.test'] });
  const post = (host: string) =>
    statusOf(port, { method: 'POST', body: INITIALIZE, headers: { ...MCP_HEADERS, Host: host } }, '/mcp');

  await expect(post('evil.test')).resolves.toBe(403);
  await expect(post(`Example.Test:${port}`)).resolves.toBe(200);
  await expect(post('example.test')).resolves.toBe(200);
});

test('a foreign Origin header is rejected and the server own origin is accepted', async () => {
  const { port } = await startStreamable();
  const post = (origin: string) =>
    statusOf(port, { method: 'POST', body: INITIALIZE, headers: { ...MCP_HEADERS, Origin: origin } }, '/mcp');

  await expect(post('http://evil.example')).resolves.toBe(403);
  await expect(post(`http://${HOST}:${port}`)).resolves.toBe(200);
});

test('--allowed-origins and --allowed-hosts set to any accept any Origin and Host', async () => {
  const { port } = await startStreamable({ allowedHosts: 'any', allowedOrigins: 'any' });

  const status = await statusOf(
    port,
    {
      method: 'POST',
      body: INITIALIZE,
      headers: { ...MCP_HEADERS, Host: 'anything.test', Origin: 'http://anything.test' },
    },
    '/mcp'
  );

  expect(status).toBe(200);
});

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

test('--session-idle-minutes=0 never closes an idle streamable HTTP session', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  cleanups.push(() => {
    vi.useRealTimers();
    return Promise.resolve();
  });
  const { port } = await startStreamable({ sessionIdleMinutes: 0 });
  const { sessionId } = await initializeSession(port);

  await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
  const status = await statusOf(
    port,
    { method: 'POST', body: '{}', headers: { ...MCP_HEADERS, 'Mcp-Session-Id': sessionId ?? '' } },
    '/mcp'
  );

  expect(sessionId).toBeTruthy();
  expect(status).not.toBe(404);
});

test('a streamable HTTP session with a request still open is not closed past --session-idle-minutes', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  cleanups.push(() => {
    vi.useRealTimers();
    return Promise.resolve();
  });
  const { port } = await startStreamable({ sessionIdleMinutes: 1 });
  const { sessionId } = await initializeSession(port);
  const headers = { Accept: 'text/event-stream', 'Mcp-Session-Id': sessionId ?? '' };
  // A listening GET stream stays open, and so counts as a request in flight.
  const stream = await new Promise<ReturnType<typeof request>>((resolve, reject) => {
    const req = request({ host: HOST, port, path: '/mcp', method: 'GET', headers }, (res) => {
      res.resume();
      resolve(req);
    });
    req.on('error', reject);
    req.end();
  });
  cleanups.push(() => {
    stream.destroy();
    return Promise.resolve();
  });

  await vi.advanceTimersByTimeAsync(120_000);
  const status = await statusOf(
    port,
    { method: 'POST', body: '{}', headers: { ...MCP_HEADERS, 'Mcp-Session-Id': sessionId ?? '' } },
    '/mcp'
  );

  expect(status).not.toBe(404);
});
