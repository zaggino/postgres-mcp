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
  /** Seconds after which Postgres cancels a statement; 0 means no timeout. */
  statementTimeoutSeconds: number;
  databases: ExplicitDatabase[];
  servers: DiscoverySource[];
  poolFactory?: PoolFactory;
  getSqlDriver?: typeof defaultGetSqlDriver;
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

const DEFAULT_PORT = '5432';
const DEFAULT_DATABASE = 'postgres';
const DISCOVERY_QUERY = 'SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname';
const POSTGRES_PROTOCOLS = new Set(['postgres:', 'postgresql:']);
const REGEX_METACHARACTERS = /[.+^${}()|[\]\\]/gu;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Only host and port of the URI discovery connects with: user names and query parameters stay out of tool output.
 * A `port` query parameter is the port pg uses, so it wins over the URL's own.
 */
function serverLabel(uri: string): string {
  try {
    if (!isPostgresUrl(uri)) {
      return new URL(uri).host;
    }
    const url = new URL(serverUriWithDefaults(uri));
    return url.hostname ? `${url.hostname}:${url.searchParams.get('port') ?? url.port}` : '';
  } catch {
    return '';
  }
}

/**
 * The URI discovery connects with: a missing port becomes 5432 and a missing database `postgres`, instead of what pg
 * would pick (`PGPORT`, and `PGDATABASE` or the user name), so a bare `postgresql://user:password@host` works.
 */
function serverUriWithDefaults(serverUri: string): string {
  const url = new URL(serverUri);
  url.port ||= DEFAULT_PORT;
  if (url.pathname === '' || url.pathname === '/') {
    url.pathname = `/${DEFAULT_DATABASE}`;
  }
  return url.toString();
}

/**
 * The URI of a discovered database. pg decodes the URL path with `decodeURI`, which leaves `%2F`, `%3F`, `%23`
 * and the other reserved escapes in place, so such a name would reach a different database than the one listed.
 */
function databaseUri(serverUri: string, datname: string, name: string): UriSpec {
  const path = encodeURIComponent(datname);
  if (decodeURI(path) !== datname) {
    return {
      error: `Database "${name}" cannot be used: its name contains characters a connection URL cannot carry (such as / ? # & =).`,
    };
  }
  const url = new URL(serverUri);
  url.pathname = `/${path}`;
  return { uri: url.toString() };
}

/**
 * An error message with any password masked. An echo of `uri` itself is replaced as a whole first, because the
 * pattern-based masking can miss a password containing `@` or other unusual characters.
 */
function maskError(error: unknown, uri: string): string {
  const message = errorMessage(error).replaceAll(uri, String(obfuscatePassword(uri)));
  return String(obfuscatePassword(message));
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

/** The longest idle time an `IdlePool` timer can hold: setTimeout accepts at most 2^31 - 1 ms; larger values would fire at once. */
export const MAX_IDLE_MINUTES = Math.floor((2 ** 31 - 1) / 60_000);

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

  // A pool marked invalid by a failed query is still held, and its idle timer still runs, so it counts as open.
  get isOpen(): boolean {
    return Boolean(this.#conn?.pool);
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
  /** Discovered database name to its URI (or why it cannot be used), from the last successful run. */
  found: Map<string, UriSpec>;
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
  readonly statementTimeoutSeconds: number;
  readonly #idleMinutes: number;
  readonly #poolFactory: PoolFactory;
  readonly #getSqlDriver: typeof defaultGetSqlDriver;
  readonly #explicit: readonly ExplicitDatabase[];
  readonly #pools = new Map<string, IdlePool>();
  /** Pools taken out of service while a call was still running; shutdown closes them too. */
  readonly #retired = new Set<IdlePool>();
  readonly #sources: SourceState[];
  #catalog: Map<string, CatalogEntry>;
  #discovering: Promise<void> | null = null;

  constructor(options: RegistryOptions) {
    this.accessMode = options.accessMode;
    this.statementTimeoutSeconds = options.statementTimeoutSeconds;
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

  describe(): { explicit: string[]; serverCount: number; prefixed: boolean } {
    return {
      explicit: this.#explicit.map(({ name }) => name),
      serverCount: this.#sources.length,
      prefixed: this.#sources.some(({ source }) => source.prefix !== ''),
    };
  }

  async use<T>(
    name: string,
    fn: (sqlDriver: SqlExecutor) => Promise<T>,
    { signal }: { signal?: AbortSignal } = {}
  ): Promise<T> {
    let entry = this.#catalog.get(name);
    if (!entry && this.#sources.length > 0) {
      await this.#discover();
      entry = this.#catalog.get(name);
    }
    if (!entry) {
      throw new DatabaseAccessError(
        `Unknown database "${name}". Call list_databases to see the available databases.${this.#discoveryFailures()}`
      );
    }
    if ('error' in entry.uri) {
      throw new DatabaseAccessError(entry.uri.error);
    }

    const { uri } = entry.uri;
    let pool = this.#pools.get(name);
    if (!pool) {
      pool = new IdlePool(uri, this.#poolFactory, this.#idleMinutes);
      this.#pools.set(name, pool);
    }
    return await pool.use((conn) => fn(this.#createDriver(conn, uri, signal)));
  }

  /** Why discovery may have missed a name: the servers whose last run failed. */
  #discoveryFailures(): string {
    const failures = this.#sources.flatMap(({ source, error }) =>
      error ? [`${'uri' in source.uri ? serverLabel(source.uri.uri) : source.prefix}: ${error}`] : []
    );
    return failures.length > 0 ? ` Discovery failed on ${failures.join('; ')}.` : '';
  }

  #createDriver(conn: DbConnPool, uri: string, signal?: AbortSignal): SqlExecutor {
    try {
      return this.#getSqlDriver(this.accessMode, conn, {
        signal,
        statementTimeoutSeconds: this.statementTimeoutSeconds,
      });
    } catch (error) {
      throw new DatabaseAccessError(maskError(error, uri), { cause: error });
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
          catalog.set(name, { source: 'server', uri });
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
    if (!isPostgresUrl(source.uri.uri)) {
      state.error = NOT_A_POSTGRES_URL;
      return;
    }
    const serverUri = serverUriWithDefaults(source.uri.uri);

    try {
      state.pool ??= new IdlePool(serverUri, this.#poolFactory, this.#idleMinutes);
      const rows = await state.pool.use((conn) => this.#createDriver(conn, serverUri).executeQuery(DISCOVERY_QUERY));

      const found = new Map<string, UriSpec>();
      for (const row of rows ?? []) {
        const datname = String(row.cells.datname);
        if (!state.matches(datname)) {
          continue;
        }
        const name = `${source.prefix}${datname}`;
        found.set(name, databaseUri(serverUri, datname, name));
      }
      state.found = found;
      state.error = null;
    } catch (error) {
      // The previous result stays usable; only this source reports the failure.
      state.error = maskError(error, serverUri);
    }
  }
}
