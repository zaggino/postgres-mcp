import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { AccessMode } from '../../src/sql/driver-factory.ts';
import { stubTransports } from '../support/transports.ts';

// `shutdown` refuses to run twice per module, so every test loads a fresh copy of main.
async function load() {
  const main = await import('../../src/main.ts');
  const { DatabaseRegistry } = await import('../../src/database-registry.ts');
  return { ...main, DatabaseRegistry };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('MCP_APP_DATABASE_URI', 'postgresql://user:password@localhost/db');
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test('shutdown on SIGTERM closes the registry and exits with 143', async () => {
  const { shutdown, DatabaseRegistry } = await load();
  const registry = new DatabaseRegistry({
    accessMode: AccessMode.UNRESTRICTED,
    idleMinutes: 0,
    statementTimeoutSeconds: 0,
    databases: [],
    servers: [],
  });
  const closeAll = vi.spyOn(registry, 'closeAll');
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- process.exit returns never; the stub must return so shutdown can finish
  const exit = vi.spyOn(process, 'exit').mockReturnValue(undefined as never);

  await shutdown(registry, 'SIGTERM');

  expect(closeAll).toHaveBeenCalledOnce();
  expect(exit).toHaveBeenCalledWith(143);
});

test('the stdio client going away closes the registry main created and exits with 0', async () => {
  const { main, DatabaseRegistry } = await load();
  const transports = stubTransports();
  const closeAll = vi.spyOn(DatabaseRegistry.prototype, 'closeAll');
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- process.exit returns never; the stub must return so shutdown can finish
  const exit = vi.spyOn(process, 'exit').mockReturnValue(undefined as never);

  await main(['--database=app'], transports);
  const onClientGone = transports.stdio.mock.calls[0]?.[1];
  onClientGone?.();

  await vi.waitFor(() => {
    expect(exit).toHaveBeenCalledWith(0);
  });
  expect(closeAll).toHaveBeenCalledOnce();
});
