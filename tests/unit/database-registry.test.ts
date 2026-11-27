import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { DiscoverySource, ExplicitDatabase, RegistryOptions } from '../../src/database-registry.ts';
import { DatabaseAccessError, DatabaseRegistry } from '../../src/database-registry.ts';
import { AccessMode, getSqlDriver } from '../../src/sql/driver-factory.ts';
import { getPostgresVersion, resetPostgresVersionCache } from '../../src/sql/extension-utils.ts';
import type { SqlExecutor } from '../../src/sql/safe-sql.ts';
import { DbConnPool } from '../../src/sql/sql-driver.ts';
import type { QueryHandler } from '../support/fake-pool.ts';
import { createFakePool, noRowsResult, rowsResult } from '../support/fake-pool.ts';

const SERVER_URI = 'postgresql://u:p@h:5432/postgres';
const APP_DB: ExplicitDatabase = { name: 'app', source: 'cli', uri: { uri: 'postgresql://h/app' } };

type FakePool = ReturnType<typeof createFakePool>;

/** Pool factory that hands out one fake pool per call and records the URLs it was given. */
function setup(handler: QueryHandler = () => [noRowsResult]) {
  const urls: string[] = [];
  const fakes: FakePool[] = [];
  const poolFactory = (url: string) => {
    urls.push(url);
    const fake = createFakePool(handler);
    fakes.push(fake);
    return fake.pool;
  };
  return { urls, fakes, poolFactory };
}

function datnames(names: string[]): QueryHandler {
  return ({ text }) =>
    text.includes('pg_database') ? [rowsResult(names.map((datname) => ({ datname })))] : [noRowsResult];
}

function source(overrides: Partial<DiscoverySource> = {}): DiscoverySource {
  return { uri: { uri: SERVER_URI }, prefix: '', include: ['*'], exclude: [], ...overrides };
}

function registry(options: Partial<RegistryOptions>) {
  return new DatabaseRegistry({
    accessMode: AccessMode.UNRESTRICTED,
    idleMinutes: 10,
    databases: [],
    servers: [],
    ...options,
  });
}

const query = (driver: SqlExecutor) => driver.executeQuery('SELECT 1 AS one');

beforeEach(() => {
  vi.useFakeTimers();
  resetPostgresVersionCache();
});

afterEach(() => {
  vi.useRealTimers();
});

test('opens a pool on first use, not at construction', async () => {
  const { urls, poolFactory } = setup();
  const reg = registry({
    poolFactory,
    databases: [APP_DB],
  });
  expect(urls).toEqual([]);

  await reg.use('app', query);
  await reg.use('app', query);

  expect(urls).toEqual(['postgresql://h/app']);
});

test('closes the pool after the idle time', async () => {
  const { fakes, poolFactory } = setup();
  const reg = registry({
    poolFactory,
    idleMinutes: 5,
    databases: [APP_DB],
  });

  await reg.use('app', query);
  await vi.advanceTimersByTimeAsync(4 * 60_000);
  expect(fakes[0]?.end).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60_000);

  expect(fakes[0]?.end).toHaveBeenCalledOnce();
});

test('does not close a pool while a call is in flight', async () => {
  const { fakes, poolFactory } = setup();
  const reg = registry({
    poolFactory,
    idleMinutes: 1,
    databases: [APP_DB],
  });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const running = reg.use('app', async (driver) => {
    await query(driver);
    await gate;
  });
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(fakes[0]?.end).not.toHaveBeenCalled();

  release();
  await running;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fakes[0]?.end).toHaveBeenCalledOnce();
});

test('a call arriving while an idle pool is closing gets a new pool', async () => {
  const { fakes, poolFactory } = setup();
  const reg = registry({ poolFactory, idleMinutes: 1, databases: [APP_DB] });
  await reg.use('app', query);
  // The first pool never finishes ending.
  fakes[0]?.end.mockReturnValue(new Promise<void>(() => {}));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fakes[0]?.end).toHaveBeenCalledOnce();

  await reg.use('app', query);

  expect(fakes).toHaveLength(2);
  expect(fakes[1]?.queries.map((q) => q.text)).toContainEqual(expect.stringContaining('SELECT 1 AS one'));
});

test('a name that rediscovery moves to another server gets a new pool and the old one closes', async () => {
  const servers = { a: ['app'], b: [] as string[] };
  const opened: { url: string; fake: FakePool }[] = [];
  const reg = registry({
    servers: [
      source({ uri: { uri: 'postgresql://u:p@a:5432/postgres' } }),
      source({ uri: { uri: 'postgresql://u:p@b:5432/postgres' } }),
    ],
    poolFactory: (url) => {
      const host = new URL(url).hostname === 'a' ? 'a' : 'b';
      const fake = createFakePool(({ text }) =>
        text.includes('pg_database') ? [rowsResult(servers[host].map((datname) => ({ datname })))] : [noRowsResult]
      );
      opened.push({ url, fake });
      return fake.pool;
    },
  });
  await reg.use('app', query);
  const first = opened.find(({ url }) => url === 'postgresql://u:p@a:5432/app');

  servers.a = [];
  servers.b = ['app'];
  await reg.list();
  await reg.use('app', query);

  expect(first?.fake.end).toHaveBeenCalledOnce();
  const second = opened.find(({ url }) => url === 'postgresql://u:p@b:5432/app');
  expect(second?.fake.queries.map((q) => q.text)).toContainEqual(expect.stringContaining('SELECT 1 AS one'));
});

test('a server uri without port or database discovers through the postgres database on port 5432', async () => {
  const { urls, poolFactory } = setup(datnames(['one']));
  const reg = registry({ poolFactory, servers: [source({ uri: { uri: 'postgresql://u:p@h' } })] });

  const { servers } = await reg.list();
  await reg.use('one', query);

  expect(urls).toEqual(['postgresql://u:p@h:5432/postgres', 'postgresql://u:p@h:5432/one']);
  expect(servers).toEqual([{ server: 'h:5432', prefix: '' }]);
});

test('a second call restarts the idle timer', async () => {
  const { fakes, poolFactory } = setup();
  const reg = registry({ poolFactory, idleMinutes: 5, databases: [APP_DB] });

  await reg.use('app', query);
  await vi.advanceTimersByTimeAsync(4 * 60_000);
  await reg.use('app', query);
  await vi.advanceTimersByTimeAsync(4 * 60_000);
  expect(fakes[0]?.end).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60_000);

  expect(fakes[0]?.end).toHaveBeenCalledOnce();
});

test('never closes when idleMinutes is 0', async () => {
  const { fakes, poolFactory } = setup();
  const reg = registry({
    poolFactory,
    idleMinutes: 0,
    databases: [APP_DB],
  });

  await reg.use('app', query);
  await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);

  expect(fakes[0]?.end).not.toHaveBeenCalled();
});

test('an explicit database wins over a discovered one of the same name', async () => {
  const { urls, poolFactory } = setup(datnames(['app']));
  const reg = registry({
    poolFactory,
    databases: [{ name: 'app', source: 'config', uri: { uri: 'postgresql://explicit/app' } }],
    servers: [source()],
  });

  await reg.use('app', query);

  expect(urls).toEqual(['postgresql://explicit/app']);
});

test('rejects a name discovered on two servers unless a prefix separates them', async () => {
  const { poolFactory } = setup(datnames(['shared']));
  const other = 'postgresql://u:p@other:5432/postgres';
  const clash = registry({ poolFactory, servers: [source(), source({ uri: { uri: other } })] });

  await expect(clash.use('shared', query)).rejects.toThrow(
    'Database "shared" is found on more than one server; set a distinct "prefix" on the servers in the config file.'
  );

  const distinct = registry({ poolFactory, servers: [source(), source({ uri: { uri: other }, prefix: 'b-' })] });
  await expect(distinct.use('b-shared', query)).resolves.toBeNull();
});

test('list shows a name found on two servers as an error entry', async () => {
  const { poolFactory } = setup(datnames(['shared']));
  const reg = registry({
    poolFactory,
    servers: [source(), source({ uri: { uri: 'postgresql://u:p@other:5432/postgres' } })],
  });

  const { databases } = await reg.list();

  expect(databases.map(({ database, state }) => ({ database, state }))).toEqual([
    { database: 'shared', state: 'error' },
  ]);
  expect(databases[0]?.error).toContain('found on more than one server');
});

test('reports a database whose uri could not be resolved', async () => {
  const { poolFactory } = setup();
  const reg = registry({
    poolFactory,
    databases: [{ name: 'app', source: 'config', uri: { error: 'environment variable APP_DATABASE_URI is not set' } }],
  });

  await expect(reg.use('app', query)).rejects.toThrow(
    'Database "app": environment variable APP_DATABASE_URI is not set'
  );
  const { databases } = await reg.list();
  expect(databases).toEqual([
    {
      database: 'app',
      source: 'config',
      state: 'error',
      idle_seconds_left: null,
      error: 'Database "app": environment variable APP_DATABASE_URI is not set',
    },
  ]);
});

test('an unknown name triggers discovery again and finds a database created since', async () => {
  let names = ['one'];
  const discoveries = vi.fn();
  const { poolFactory } = setup((recorded) => {
    if (recorded.text.includes('pg_database')) {
      discoveries();
    }
    return datnames(names)(recorded);
  });
  const reg = registry({ poolFactory, servers: [source()] });

  await expect(reg.use('two', query)).rejects.toThrow(
    'Unknown database "two". Call list_databases to see the available databases.'
  );
  expect(discoveries).toHaveBeenCalledOnce();

  names = ['one', 'two'];
  await reg.use('two', query);

  expect(discoveries).toHaveBeenCalledTimes(2);
});

test('a name that vanishes from discovery has its pool closed and becomes unknown', async () => {
  let names = ['one'];
  const { urls, fakes, poolFactory } = setup((recorded) => datnames(names)(recorded));
  const reg = registry({ poolFactory, servers: [source()] });
  await reg.use('one', query);

  names = [];
  await reg.list();

  expect(fakes[urls.indexOf('postgresql://u:p@h:5432/one')]?.end).toHaveBeenCalledOnce();
  await expect(reg.use('one', query)).rejects.toThrow('Unknown database "one"');
});

test('a driver that cannot be created fails the call with a masked DatabaseAccessError', async () => {
  const reg = registry({
    databases: [APP_DB],
    getSqlDriver: () => {
      throw new Error('cannot use postgresql://u:secret@h/app');
    },
  });

  const failure = reg.use('app', query);

  await expect(failure).rejects.toBeInstanceOf(DatabaseAccessError);
  await expect(failure).rejects.toThrow(/cannot use postgresql:\/\/u:.*@h\/app/u);
  await expect(failure).rejects.not.toThrow(/secret/u);
});

test('a driver that cannot be created for discovery is reported on its server, masked', async () => {
  const reg = registry({
    servers: [source()],
    getSqlDriver: () => {
      throw new Error('cannot use postgresql://u:secret@h/postgres');
    },
  });

  const { servers } = await reg.list();

  expect(servers[0]?.error).toMatch(/cannot use postgresql:\/\/u:.*@h\/postgres/u);
  expect(servers[0]?.error).not.toContain('secret');
});

test('a discovered name with a reserved URL character is an error, not a connection to another database', async () => {
  const { urls, poolFactory } = setup(datnames(['a/b', 'ok']));
  const reg = registry({ poolFactory, servers: [source()] });

  const { databases } = await reg.list();

  expect(databases.find(({ database }) => database === 'a/b')).toMatchObject({
    state: 'error',
    error: expect.stringContaining('cannot be used') as unknown,
  });
  await expect(reg.use('a/b', query)).rejects.toThrow('Database "a/b" cannot be used');
  expect(urls.filter((url) => !url.endsWith('/postgres'))).toEqual([]);
});

test('an unknown name names the servers whose discovery failed', async () => {
  const { poolFactory } = setup(() => {
    throw new Error('connection refused');
  });
  const reg = registry({ poolFactory, servers: [source()] });

  await expect(reg.use('missing', query)).rejects.toThrow(
    'Unknown database "missing". Call list_databases to see the available databases. Discovery failed on h:5432: Connection attempt failed: connection refused.'
  );
});

test('a pool whose last query failed still lists as open while its idle timer runs', async () => {
  const { poolFactory } = setup(({ text }) => {
    if (text.includes('SELECT 1 AS one')) {
      throw new Error('syntax error');
    }
    return [noRowsResult];
  });
  const reg = registry({ poolFactory, idleMinutes: 5, databases: [APP_DB] });
  await expect(reg.use('app', query)).rejects.toThrow('syntax error');

  const { databases } = await reg.list();

  expect(databases[0]).toMatchObject({ database: 'app', state: 'open', idle_seconds_left: 300 });
});

test('closeAll also closes a pool retired while its call is still running', async () => {
  let names = ['one'];
  const { urls, fakes, poolFactory } = setup((recorded) => datnames(names)(recorded));
  const reg = registry({ poolFactory, servers: [source()] });
  const { promise: gate, resolve: release } = Promise.withResolvers<undefined>();
  const running = reg.use('one', async (driver) => {
    await query(driver);
    await gate;
  });
  await vi.advanceTimersByTimeAsync(0);

  names = [];
  await reg.list();
  const retired = fakes[urls.indexOf('postgresql://u:p@h:5432/one')];
  expect(retired?.end).not.toHaveBeenCalled();
  await reg.closeAll();

  expect(retired?.end).toHaveBeenCalledOnce();
  release(undefined);
  await running;
});

test('the discovery query passes restricted-mode validation', async () => {
  const { fakes, poolFactory } = setup(datnames(['app']));
  const reg = registry({ poolFactory, accessMode: AccessMode.RESTRICTED, servers: [source()] });

  const { databases } = await reg.list();

  expect(databases.map((entry) => entry.database)).toEqual(['app']);
  expect(fakes[0]?.queries.some(({ text }) => text.includes('pg_database'))).toBe(true);
});

test('applies include, exclude and prefix, and points each database at its own URI', async () => {
  const { urls, poolFactory } = setup(datnames(['app1', 'app2', 'my db', 'postgres']));
  const reg = registry({
    poolFactory,
    servers: [source({ prefix: 'stg-', include: ['app?', 'my *', 'postgres'], exclude: ['postgres', 'app2'] })],
  });

  const { databases } = await reg.list();
  expect(databases.map((entry) => entry.database)).toEqual(['stg-app1', 'stg-my db']);

  await reg.use('stg-my db', query);
  expect(urls.at(-1)).toBe('postgresql://u:p@h:5432/my%20db');
});

test('keeps the version cache separate for each connection pool', async () => {
  const versioned =
    (version: string): QueryHandler =>
    ({ text }) =>
      text === 'SHOW server_version' ? [rowsResult([{ server_version: version }])] : [noRowsResult];
  const a = createFakePool(versioned('15.4'));
  const b = createFakePool(versioned('16.2'));

  const versionA = await getPostgresVersion(
    getSqlDriver(AccessMode.UNRESTRICTED, new DbConnPool('postgresql://h/a', () => a.pool))
  );
  const versionB = await getPostgresVersion(
    getSqlDriver(AccessMode.UNRESTRICTED, new DbConnPool('postgresql://h/b', () => b.pool))
  );

  expect([versionA, versionB]).toEqual([15, 16]);
});

test('caches the version per executor when the executor has no pool', async () => {
  const executor = (version: string) => {
    const executeQuery = vi.fn(() => Promise.resolve([{ cells: { server_version: version } }]));
    return { executeQuery, driver: { executeQuery } satisfies SqlExecutor };
  };
  const a = executor('15.4');
  const b = executor('16.2');

  const versions = [
    await getPostgresVersion(a.driver),
    await getPostgresVersion(a.driver),
    await getPostgresVersion(b.driver),
  ];

  expect(versions).toEqual([15, 15, 16]);
  expect(a.executeQuery).toHaveBeenCalledOnce();
});
