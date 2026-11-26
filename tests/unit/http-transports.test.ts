import { request } from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, expect, it as test, vi } from 'vitest';

import type { HttpServerHandle } from '../../src/server.ts';
import { AccessMode, createServer, startSseServer, startStreamableHttpServer } from '../../src/server.ts';

const HOST = '127.0.0.1';
const TOOL_COUNT = 9;

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  vi.restoreAllMocks();
});

function factory() {
  return createServer(AccessMode.UNRESTRICTED);
}

async function startStreamable(): Promise<HttpServerHandle> {
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const handle = await startStreamableHttpServer(factory, HOST, 0);
  cleanups.push(handle.close);
  return handle;
}

async function startSse(): Promise<HttpServerHandle> {
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const handle = await startSseServer(factory, HOST, 0);
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

test('streamable HTTP serves the nine tools to the SDK client', async () => {
  const { port } = await startStreamable();

  const tools = await listToolsThrough(
    new Client({ name: 'test-client', version: '0.0.0' }),
    new StreamableHTTPClientTransport(new URL(`http://${HOST}:${port}/mcp`))
  );

  expect(tools).toHaveLength(TOOL_COUNT);
});

test('SSE serves the nine tools to the SDK client', async () => {
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
