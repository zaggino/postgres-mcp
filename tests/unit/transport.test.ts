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

    expect(transports.stdio).toHaveBeenCalledOnce();
    expect(transports['streamable-http']).not.toHaveBeenCalled();
  });

  it('--transport=streamable-http runs only the streamable HTTP transport', async () => {
    const transports = stubTransports();

    await main([DATABASE_ARG, '--transport=streamable-http'], transports);

    expect(transports.stdio).not.toHaveBeenCalled();
    expect(transports['streamable-http']).toHaveBeenCalledOnce();
  });

  it('defaults to the stdio transport', async () => {
    const transports = stubTransports();

    await main([DATABASE_ARG], transports);

    expect(transports.stdio).toHaveBeenCalledOnce();
    expect(transports['streamable-http']).not.toHaveBeenCalled();
  });

  it('accepts a separate value for --transport', async () => {
    const transports = stubTransports();

    await main([DATABASE_ARG, '--transport', 'streamable-http'], transports);

    expect(transports['streamable-http']).toHaveBeenCalledOnce();
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

    expect(transports['streamable-http']).toHaveBeenCalledWith(expect.any(Function), {
      host: '0.0.0.0',
      port: 9000,
      allowedHosts: ['mcp.example', 'other.example:9000'],
      allowedOrigins: ['https://app.example'],
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
