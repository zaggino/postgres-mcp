import type { AccessMode } from './sql/driver-factory.ts';
import { getSqlDriver as defaultGetSqlDriver } from './sql/driver-factory.ts';
import type { SqlExecutor } from './sql/safe-sql.ts';
import type { PoolFactory } from './sql/sql-driver.ts';
import { DbConnPool, defaultPoolFactory, obfuscatePassword } from './sql/sql-driver.ts';

export type UriSpec = { uri: string } | { error: string };

export interface ExplicitDatabase {
  name: string;
  source: 'cli' | 'config';
  uri: UriSpec;
}

export interface DiscoverySource {
  uri: UriSpec;
  prefix: string;
  include: string[];
  exclude: string[];
}

export interface RegistryOptions {
  accessMode: AccessMode;
  /** Minutes without a call in flight before a pool closes; 0 never closes. */
  idleMinutes: number;
  databases: ExplicitDatabase[];
  servers: DiscoverySource[];
  poolFactory?: PoolFactory;
  getSqlDriver?: (accessMode: AccessMode, conn: DbConnPool) => SqlExecutor;
}

export interface DatabaseListing {
  database: string;
  source: 'cli' | 'config' | 'server';
  state: 'open' | 'closed' | 'error';
  idle_seconds_left: number | null;
  error?: string;
}

export interface ServerListing {
  server: string;
  prefix: string;
  error?: string;
}

export interface RegistryListing {
  databases: DatabaseListing[];
  servers: ServerListing[];
}

/** A database that cannot be used: unknown, misconfigured, ambiguous, or its driver cannot be created. */
export class DatabaseAccessError extends Error {}

export const NOT_A_POSTGRES_URL = 'Server uri must be a postgres:// or postgresql:// URL';

const DISCOVERY_QUERY = 'SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname';
const POSTGRES_PROTOCOLS = new Set(['postgres:', 'postgresql:']);
const REGEX_METACHARACTERS = /[.+^${}()|[\]\\]/gu;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Only host and port: user names and query parameters stay out of tool output. */
function serverLabel(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return '';
  }
}

function globToRegExp(glob: string): RegExp {
  const pattern = glob
    .replaceAll(REGEX_METACHARACTERS, String.raw`\$&`)
    .replaceAll('*', '.*')
    .replaceAll('?', '.');
  return new RegExp(`^${pattern}$`, 'su');
}

export function isPostgresUrl(uri: string): boolean {
  try {
    return POSTGRES_PROTOCOLS.has(new URL(uri).protocol);
  } catch {
    return false;
  }
}

/** A lazily created pool that closes after it has been idle with no call in flight. */
class IdlePool {
  readonly #uri: string;
  readonly #poolFactory: PoolFactory;
  readonly #idleMs: number;
  #conn: DbConnPool | null = null;
  #inFlight = 0;
  #timer: NodeJS.Timeout | null = null;
  #deadline: number | null = null;
  #retired = false;

  constructor(uri: string, poolFactory: PoolFactory, idleMinutes: number) {
    this.#uri = uri;
    this.#poolFactory = poolFactory;
    this.#idleMs = idleMinutes * 60_000;
  }

  get uri(): string {
    return this.#uri;
  }

  get isOpen(): boolean {
    return Boolean(this.#conn?.pool && this.#conn.isValid);
  }

  /** Retired and with no call left in flight, so its pool is closed or closing. */
  get isFinished(): boolean {
    return this.#retired && this.#inFlight === 0;
  }

  get secondsLeft(): number | null {
    return this.#deadline === null ? null : Math.max(0, Math.ceil((this.#deadline - Date.now()) / 1000));
  }

  async use<T>(fn: (conn: DbConnPool) => Promise<T>): Promise<T> {
    this.#conn ??= new DbConnPool(this.#uri, this.#poolFactory);
    const conn = this.#conn;
    this.#inFlight += 1;
    this.#clearTimer();
    try {
      return await fn(conn);
    } finally {
      this.#inFlight -= 1;
      if (this.#inFlight === 0) {
        if (this.#retired) {
          this.#closeInBackground();
        } else {
          this.#armTimer();
        }
      }
    }
  }

  async close(): Promise<void> {
    this.#clearTimer();
    await this.#detach()?.close();
  }

  /** Stop handing out this pool; it closes once its calls in flight finish. */
  retire(): void {
    this.#retired = true;
    this.#clearTimer();
    if (this.#inFlight === 0) {
      this.#closeInBackground();
    }
  }

  // A call arriving while the old pool is ending gets a fresh DbConnPool instead of the closing one.
  #detach(): DbConnPool | null {
    const conn = this.#conn;
    this.#conn = null;
    return conn;
  }

  #closeInBackground(): void {
    this.#detach()
      ?.close()
      .catch((error: unknown) => {
        process.stderr.write(`Error closing idle connection pool: ${errorMessage(error)}\n`);
      });
  }

  #clearTimer(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
    }
    this.#timer = null;
    this.#deadline = null;
  }

  #armTimer(): void {
    if (this.#idleMs <= 0) {
      return;
    }
    this.#deadline = Date.now() + this.#idleMs;
    const timer = setTimeout(() => {
      this.#timer = null;
      this.#deadline = null;
      this.#closeInBackground();
    }, this.#idleMs);
    timer.unref();
    this.#timer = timer;
  }
}

interface SourceState {
  source: DiscoverySource;
  pool: IdlePool | null;
  /** Whether a discovered database name passes the source's include and exclude globs. */
  matches: (datname: string) => boolean;
  /** Discovered database name to its URI, from the last successful run. */
  found: Map<string, string>;
  error: string | null;
}

interface CatalogEntry {
  source: 'cli' | 'config' | 'server';
  uri: UriSpec;
}

function createMatcher({ include, exclude }: DiscoverySource): (datname: string) => boolean {
  const included = include.map((glob) => globToRegExp(glob));
  const excluded = exclude.map((glob) => globToRegExp(glob));
  return (datname) => included.some((re) => re.test(datname)) && !excluded.some((re) => re.test(datname));
}

function poolState(pool: IdlePool | undefined): 'open' | 'closed' {
  return pool?.isOpen ? 'open' : 'closed';
}

export class DatabaseRegistry {
  readonly accessMode: AccessMode;
  readonly #idleMinutes: number;
  readonly #poolFactory: PoolFactory;
  readonly #getSqlDriver: (accessMode: AccessMode, conn: DbConnPool) => SqlExecutor;
  readonly #explicit: readonly ExplicitDatabase[];
  readonly #pools = new Map<string, IdlePool>();
  /** Pools taken out of service while a call was still running; shutdown closes them too. */
  readonly #retired = new Set<IdlePool>();
  readonly #sources: SourceState[];
  #catalog: Map<string, CatalogEntry>;
  #discovering: Promise<void> | null = null;

  constructor(options: RegistryOptions) {
    this.accessMode = options.accessMode;
    this.#idleMinutes = options.idleMinutes;
    this.#poolFactory = options.poolFactory ?? defaultPoolFactory;
    this.#getSqlDriver = options.getSqlDriver ?? defaultGetSqlDriver;
    this.#explicit = options.databases;
    this.#sources = options.servers.map((source) => ({
      source,
      pool: null,
      matches: createMatcher(source),
      found: new Map(),
      error: null,
    }));
    this.#catalog = this.#buildCatalog();
  }

  describe(): { explicit: string[]; serverCount: number } {
    return { explicit: this.#explicit.map(({ name }) => name), serverCount: this.#sources.length };
  }

  async use<T>(name: string, fn: (sqlDriver: SqlExecutor) => Promise<T>): Promise<T> {
    let entry = this.#catalog.get(name);
    if (!entry) {
      await this.#discover();
      entry = this.#catalog.get(name);
    }
    if (!entry) {
      throw new DatabaseAccessError(`Unknown database "${name}". Call list_databases to see the available databases.`);
    }
    if ('error' in entry.uri) {
      throw new DatabaseAccessError(entry.uri.error);
    }

    let pool = this.#pools.get(name);
    if (!pool) {
      pool = new IdlePool(entry.uri.uri, this.#poolFactory, this.#idleMinutes);
      this.#pools.set(name, pool);
    }
    return await pool.use((conn) => fn(this.#createDriver(conn)));
  }

  #createDriver(conn: DbConnPool): SqlExecutor {
    try {
      return this.#getSqlDriver(this.accessMode, conn);
    } catch (error) {
      throw new DatabaseAccessError(String(obfuscatePassword(errorMessage(error))), { cause: error });
    }
  }

  async list(): Promise<RegistryListing> {
    await this.#discover();

    const databases = [...this.#catalog]
      .map(([name, { source, uri }]): DatabaseListing => {
        const pool = this.#pools.get(name);
        return {
          database: name,
          source,
          state: 'error' in uri ? 'error' : poolState(pool),
          idle_seconds_left: pool?.secondsLeft ?? null,
          ...('error' in uri && { error: uri.error }),
        };
      })
      .sort((a, b) => (a.database < b.database ? -1 : Number(a.database > b.database)));

    const servers = this.#sources.map(({ source, error }): ServerListing => {
      const listing: ServerListing = {
        server: 'uri' in source.uri ? serverLabel(source.uri.uri) : '',
        prefix: source.prefix,
      };
      const message = 'error' in source.uri ? source.uri.error : error;
      if (message) {
        listing.error = message;
      }
      return listing;
    });

    return { databases, servers };
  }

  async closeAll(): Promise<void> {
    const pools = [
      ...this.#pools.values(),
      ...this.#retired,
      ...this.#sources.flatMap(({ pool }) => (pool ? [pool] : [])),
    ];
    await Promise.all(pools.map((pool) => pool.close()));
  }

  /** The name catalog from the explicit databases and the last discovery results. */
  #buildCatalog(): Map<string, CatalogEntry> {
    const catalog = new Map<string, CatalogEntry>();
    for (const { found } of this.#sources) {
      for (const [name, uri] of found) {
        if (catalog.has(name)) {
          const error = `Database "${name}" is found on more than one server; set a distinct "prefix" on the servers in the config file.`;
          catalog.set(name, { source: 'server', uri: { error } });
        } else {
          catalog.set(name, { source: 'server', uri: { uri } });
        }
      }
    }
    for (const { name, source, uri } of this.#explicit) {
      catalog.set(name, {
        source,
        uri: 'error' in uri ? { error: `Database "${name}": ${uri.error}` } : uri,
      });
    }
    return catalog;
  }

  /** A name that vanished, became an error, or moved to another database must not reuse its old connection. */
  #retireStalePools(): void {
    for (const [name, pool] of this.#pools) {
      const entry = this.#catalog.get(name);
      if (!entry || 'error' in entry.uri || entry.uri.uri !== pool.uri) {
        pool.retire();
        this.#pools.delete(name);
        this.#retired.add(pool);
      }
    }
    for (const pool of this.#retired) {
      if (pool.isFinished) {
        this.#retired.delete(pool);
      }
    }
  }

  #discover(): Promise<void> {
    this.#discovering ??= this.#discoverAll().finally(() => {
      this.#discovering = null;
    });
    return this.#discovering;
  }

  async #discoverAll(): Promise<void> {
    await Promise.all(this.#sources.map((state) => this.#discoverSource(state)));
    this.#catalog = this.#buildCatalog();
    this.#retireStalePools();
  }

  async #discoverSource(state: SourceState): Promise<void> {
    const { source } = state;
    if ('error' in source.uri) {
      state.error = source.uri.error;
      return;
    }
    const serverUri = source.uri.uri;
    if (!isPostgresUrl(serverUri)) {
      state.error = NOT_A_POSTGRES_URL;
      return;
    }

    try {
      state.pool ??= new IdlePool(serverUri, this.#poolFactory, this.#idleMinutes);
      const rows = await state.pool.use((conn) => this.#createDriver(conn).executeQuery(DISCOVERY_QUERY));

      const found = new Map<string, string>();
      for (const row of rows ?? []) {
        const datname = String(row.cells.datname);
        if (!state.matches(datname)) {
          continue;
        }
        const url = new URL(serverUri);
        url.pathname = `/${encodeURIComponent(datname)}`;
        found.set(`${source.prefix}${datname}`, url.toString());
      }
      state.found = found;
      state.error = null;
    } catch (error) {
      // The previous result stays usable; only this source reports the failure.
      state.error = String(obfuscatePassword(errorMessage(error)));
    }
  }
}
