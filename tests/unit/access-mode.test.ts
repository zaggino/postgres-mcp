import { afterEach, describe, expect, it, vi } from 'vitest';

import { main, runners } from '../../src/server.ts';
import { AccessMode, getSqlDriver } from '../../src/sql/driver-factory.ts';
import { SafeSqlDriver } from '../../src/sql/safe-sql.ts';
import { DbConnPool, SqlDriver } from '../../src/sql/sql-driver.ts';
import { connectClient } from '../support/mcp-client.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe(getSqlDriver, () => {
  it.each([
    [AccessMode.UNRESTRICTED, SqlDriver],
    [AccessMode.RESTRICTED, SafeSqlDriver],
  ])('returns the driver for %s mode', (accessMode, expectedType) => {
    const driver = getSqlDriver(accessMode, new DbConnPool(), { statementTimeoutSeconds: 0 });

    expect(driver).toBeInstanceOf(expectedType);
  });
});

describe('command line access mode', () => {
  it('--access-mode=restricted serves the read-only execute_sql tool', async () => {
    vi.stubEnv('MCP_APP_DATABASE_URI', 'postgresql://user:password@localhost/db');
    const runStdio = vi.spyOn(runners, 'runStdio').mockResolvedValue();

    await main(['--database=app', '--access-mode=restricted']);

    const factory = runStdio.mock.calls[0]?.[0];
    if (!factory) {
      throw new Error('runStdio was not called');
    }
    const client = await connectClient(factory());
    const { tools } = await client.listTools();
    const executeSql = tools.find((tool) => tool.name === 'execute_sql');
    expect(executeSql?.description).toBe('Execute a read-only SQL query');
    expect(executeSql?.annotations?.readOnlyHint).toBe(true);
  });
});
