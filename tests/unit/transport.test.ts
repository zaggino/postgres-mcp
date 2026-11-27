import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { main } from '../../src/main.ts';
import { stubTransports } from '../support/transports.ts';

const DATABASE_ARG = '--database=app';

beforeEach(() => {
  vi.stubEnv('MCP_APP_DATABASE_URI', 'postgresql://user:password@localhost/db');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('transport selection', () => {
  it('--transport=stdio runs only the stdio transport', async () => {
    const transports = stubTransports();

    await main([DATABASE_ARG, '--transport=stdio'], transports);

    expect(transports.runStdio).toHaveBeenCalledOnce();
    expect(transports.runSse).not.toHaveBeenCalled();
    expect(transports.runStreamableHttp).not.toHaveBeenCalled();
  });

  it('--transport=sse runs only the SSE transport', async () => {
    const transports = stubTransports();

    await main([DATABASE_ARG, '--transport=sse'], transports);

    expect(transports.runStdio).not.toHaveBeenCalled();
    expect(transports.runSse).toHaveBeenCalledOnce();
    expect(transports.runStreamableHttp).not.toHaveBeenCalled();
  });

  it('--transport=streamable-http runs only the streamable HTTP transport', async () => {
    const transports = stubTransports();

    await main([DATABASE_ARG, '--transport=streamable-http'], transports);

    expect(transports.runStdio).not.toHaveBeenCalled();
    expect(transports.runSse).not.toHaveBeenCalled();
    expect(transports.runStreamableHttp).toHaveBeenCalledOnce();
  });

  it('defaults to the stdio transport', async () => {
    const transports = stubTransports();

    await main([DATABASE_ARG], transports);

    expect(transports.runStdio).toHaveBeenCalledOnce();
    expect(transports.runSse).not.toHaveBeenCalled();
    expect(transports.runStreamableHttp).not.toHaveBeenCalled();
  });

  it('accepts a separate value for --transport', async () => {
    const transports = stubTransports();

    await main([DATABASE_ARG, '--transport', 'sse'], transports);

    expect(transports.runSse).toHaveBeenCalledOnce();
  });
});

describe('transport host and port', () => {
  it('passes the streamable HTTP host and port to the transport', async () => {
    const transports = stubTransports();

    await main(
      [
        DATABASE_ARG,
        '--transport=streamable-http',
        '--streamable-http-host=0.0.0.0',
        '--streamable-http-port=9000',
        '--allowed-hosts=mcp.example,other.example:9000',
        '--allowed-origins=https://app.example',
      ],
      transports
    );

    expect(transports.runStreamableHttp).toHaveBeenCalledWith(expect.any(Function), {
      host: '0.0.0.0',
      port: 9000,
      allowedHosts: ['mcp.example', 'other.example:9000'],
      allowedOrigins: ['https://app.example'],
      maxSessions: undefined,
      sessionIdleMinutes: undefined,
    });
  });

  it('passes the SSE host and port to the transport', async () => {
    const transports = stubTransports();

    await main(
      [DATABASE_ARG, '--transport=sse', '--sse-host=0.0.0.0', '--sse-port=8080', '--allowed-hosts=*'],
      transports
    );

    expect(transports.runSse).toHaveBeenCalledWith(expect.any(Function), {
      host: '0.0.0.0',
      port: 8080,
      allowedHosts: 'any',
      allowedOrigins: undefined,
      maxSessions: undefined,
      sessionIdleMinutes: undefined,
    });
  });
});

describe('usage errors', () => {
  it('main prints the usage and the error to stderr and exits with code 2 when no database is configured', async () => {
    const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });

    await expect(main([])).rejects.toThrow('exit 2');

    const output = written.join('');
    expect(output).toContain('usage:');
    expect(output).toContain('postgres-mcp: error: no databases configured');
  });
});
