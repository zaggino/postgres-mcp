import { DatabaseRegistry } from '../../src/database-registry.ts';
import type { ExplicitDatabase, RegistryOptions } from '../../src/database-registry.ts';
import { AccessMode, defaultStatementTimeoutSeconds } from '../../src/sql/driver-factory.ts';
import type { QueryHandler } from './fake-pool.ts';
import { createFakePool } from './fake-pool.ts';

export type FakePool = ReturnType<typeof createFakePool>;

/**
 * A registry over explicitly named databases whose pools are fakes, created on first use.
 * `fakes` holds one entry per database that has actually been connected to.
 */
export function createTestRegistry(
  names: string[],
  options: {
    accessMode?: AccessMode;
    handler?: QueryHandler;
    servers?: RegistryOptions['servers'];
    /** Extra entries, e.g. one whose URI failed to resolve. */
    databases?: ExplicitDatabase[];
    statementTimeoutSeconds?: number;
    /** Replaces the driver factory, e.g. to answer queries without a pool. */
    getSqlDriver?: RegistryOptions['getSqlDriver'];
  } = {}
) {
  const fakes = new Map<string, FakePool>();
  const accessMode = options.accessMode ?? AccessMode.UNRESTRICTED;
  const registry = new DatabaseRegistry({
    accessMode,
    idleMinutes: 0,
    statementTimeoutSeconds: options.statementTimeoutSeconds ?? defaultStatementTimeoutSeconds(accessMode),
    databases: [
      ...names.map((name): ExplicitDatabase => ({
        name,
        source: 'cli',
        uri: { uri: `postgresql://u:p@h:5432/${name}` },
      })),
      ...(options.databases ?? []),
    ],
    servers: options.servers ?? [],
    getSqlDriver: options.getSqlDriver,
    poolFactory: (url) => {
      const fake = createFakePool(options.handler);
      fakes.set(decodeURIComponent(new URL(url).pathname.slice(1)), fake);
      return fake.pool;
    },
  });
  return { registry, fakes };
}
