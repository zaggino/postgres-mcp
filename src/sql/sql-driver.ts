import net from 'node:net';

import pg from 'pg';

import { errorMessage } from '../errors.ts';
import { logLine } from '../log.ts';
import type { QueuedPool } from './connection-queue.ts';
import { PoolClosedError, queuedPool } from './connection-queue.ts';
import { customTypes } from './type-parsers.ts';

const URL_PREFIX = /^(?<scheme>[a-zA-Z][a-zA-Z0-9+.-]*):\/\/(?<netloc>[^/?#]*)/u;
const EMBEDDED_URL = /(?<head>postgres(?:ql)?:\/\/[^:]+:)(?<password>[^@]+)(?<tail>@[^/\s]+)/gu;
const PASSWORD_PARAM = /(?<key>password=)(?<value>[^\s&;"']+)/giu;
const DSN_SINGLE_QUOTE = /(?<key>password\s*=\s*')(?<value>[^']+)(?<end>')/giu;
const DSN_DOUBLE_QUOTE = /(?<key>password\s*=\s*")(?<value>[^"]+)(?<end>")/giu;

/** One result row, keyed by column name, with values as pg's type parsers produce them. */
export type Row = Record<string, unknown>;

/** The last statement's result: column names, then rows. No columns means the statement returned no result set. */
export interface ResultSet {
  columns: readonly string[];
  rows: Row[];
}

export interface QueryResultLike {
  fields: readonly { name: string }[];
  rows: Row[];
}

export interface ClientLike {
  /** One result per statement; a single statement yields a one-element array. */
  query: (text: string, values?: readonly unknown[]) => Promise<QueryResultLike[]>;
  release: (destroy?: boolean) => void;
  /** Asks Postgres to cancel whatever this client's backend is running. Never rejects. */
  cancel: () => Promise<void>;
}

/** A pool as a PoolFactory makes it; DbConnPool puts queuedPool in front of it. */
export interface PoolLike {
  connect: () => Promise<ClientLike>;
  end: () => Promise<void>;
}

export type PoolFactory = (connectionString: string) => PoolLike;

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new QueryCancelledError();
  }
}

/**
 * Waits for `promise` unless `signal` aborts first, in which case it rejects with QueryCancelledError. Used only for
 * the shared connection attempt, which other callers still wait for, so nothing is left to clean up.
 */
async function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) {
    return await promise;
  }
  const aborted = Promise.withResolvers<never>();
  const onAbort = () => {
    aborted.reject(new QueryCancelledError());
  };
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await Promise.race([promise, aborted.promise]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * SQLSTATEs Postgres reports with FATAL severity. pg exposes only the localized severity, so these codes keep the
 * check working under a non-English lc_messages: connection exceptions (08), authorization (28), too many
 * connections (53300), and admin shutdown, crash shutdown and cannot-connect-now (57P01-57P03).
 */
const CONNECTION_SQLSTATE = /^(?:08|28|53300$|57P0[1-3]$)/u;

/**
 * Whether Postgres rejected the statement on a connection that stays usable: a pg.DatabaseError that is neither
 * FATAL/PANIC nor one of the connection-ending SQLSTATEs.
 */
export function isStatementError(error: unknown): error is pg.DatabaseError {
  return (
    error instanceof pg.DatabaseError &&
    error.severity !== 'FATAL' &&
    error.severity !== 'PANIC' &&
    !CONNECTION_SQLSTATE.test(error.code ?? '')
  );
}

/**
 * What a failure says about the connection. `answered`: Postgres rejected the statement or timed it out, so the
 * connection works. `cancelled`: the caller gave up, which says nothing about it. `connection`: anything else,
 * deliberately including errors that are not from Postgres at all (a lost socket, a client-side failure), because when
 * it is unclear whether the connection survived it is not reused.
 */
function failureKind(error: unknown): 'answered' | 'cancelled' | 'connection' {
  if (isStatementError(error) || error instanceof QueryTimeoutError) {
    return 'answered';
  }
  return error instanceof QueryCancelledError ? 'cancelled' : 'connection';
}

/** Raised when the caller's AbortSignal cancelled the statement. Deliberately not a pg.DatabaseError. */
export class QueryCancelledError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Query cancelled', options);
    this.name = 'QueryCancelledError';
  }
}

/** Raised when Postgres aborted the statement for exceeding statement_timeout. */
export class QueryTimeoutError extends Error {
  readonly seconds: number;

  constructor(seconds: number, { cause }: { cause?: unknown } = {}) {
    super(
      `Query execution timed out after ${seconds} seconds. Consider simplifying your query or increasing the timeout.`,
      {
        cause,
      }
    );
    this.name = 'QueryTimeoutError';
    this.seconds = seconds;
  }
}

export function obfuscatePassword(text: string | null | undefined): string | null | undefined {
  if (text === null || text === undefined) {
    return text;
  }
  if (!text) {
    return text;
  }

  // Proper URL: scheme://[user[:password]@]host...
  const urlMatch = URL_PREFIX.exec(text);
  if (urlMatch) {
    const netloc = urlMatch.groups?.netloc ?? '';
    const at = netloc.lastIndexOf('@');
    if (at !== -1) {
      const userinfo = netloc.slice(0, at);
      const colon = userinfo.indexOf(':');
      const password = colon === -1 ? '' : userinfo.slice(colon + 1);
      if (password) {
        const obfuscatedNetloc = netloc.replaceAll(password, '****');
        const prefix = `${urlMatch.groups?.scheme ?? ''}://`;
        return `${prefix}${obfuscatedNetloc}${text.slice(prefix.length + netloc.length)}`;
      }
    }
  }

  return maskPasswordPatterns(text);
}

/** The pattern-based half of obfuscatePassword: embedded URLs, `password=` parameters and quoted DSN passwords. */
function maskPasswordPatterns(text: string): string {
  // Connection strings embedded in other text: postgres://user:password@host
  let result = text.replaceAll(EMBEDDED_URL, '$<head>****$<tail>');
  // password=xxx
  result = result.replaceAll(PASSWORD_PARAM, '$<key>****');
  // DSN with single quotes
  result = result.replaceAll(DSN_SINGLE_QUOTE, '$<key>****$<end>');
  // DSN with double quotes
  result = result.replaceAll(DSN_DOUBLE_QUOTE, '$<key>****$<end>');
  return result;
}

/**
 * Every password pattern masked. obfuscatePassword (kept as upstream wrote it) masks only the userinfo of text that
 * starts with a URL and skips the patterns for the rest, so they run again on its result.
 */
function maskSecrets(text: string): string {
  return maskPasswordPatterns(obfuscatePassword(text) ?? '');
}

/**
 * An error message with any password masked. An echo of `uri` itself is replaced as a whole first, because the
 * pattern-based masking can miss a password containing `@` or other unusual characters. The replacement is a callback
 * so `$&` and the like in the URI are inserted literally rather than read as replacement patterns.
 */
export function maskError(error: unknown, uri: string | undefined): string {
  const message = errorMessage(error);
  if (!uri) {
    return maskSecrets(message);
  }
  const masked = maskSecrets(uri);
  return maskSecrets(message.replaceAll(uri, () => masked));
}

const CANCEL_REQUEST_CODE = 80_877_102;
const APPLICATION_NAME = 'postgres-mcp';
/** How long a call waits for a free client when all of the pool's connections are busy. */
const POOL_WAIT_TIMEOUT_MS = 30_000;
/** Connections per database pool; queuedPool admits as many checkouts, so pg-pool itself never queues. */
const POOL_MAX = 5;
/**
 * How long opening one new connection may take, so an unreachable database fails fast. pg-pool applies
 * `connectionTimeoutMillis` to its own queue as well, which queuedPool keeps empty, so here it bounds only the open.
 */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Pool config for a connection string. pg lets a connection string's own parameters override config fields but
 * lets config.application_name beat PGAPPNAME, so the default is set only when neither the URI nor PGAPPNAME has one.
 */
export function poolConfig(connectionString: string, env: NodeJS.ProcessEnv = process.env): pg.PoolConfig {
  let uriHasApplicationName = false;
  try {
    uriHasApplicationName = new URL(connectionString).searchParams.has('application_name');
  } catch {
    // Not a URL; pg parses it its own way and any application_name in it still overrides ours.
  }
  return {
    connectionString,
    max: POOL_MAX,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    types: customTypes,
    ...(uriHasApplicationName || env.PGAPPNAME ? {} : { application_name: APPLICATION_NAME }),
  };
}

/** Sends a protocol CancelRequest for a backend on a fresh socket; resolves once the socket closes. */
function sendCancelRequest(client: pg.PoolClient): Promise<void> {
  // processID and secretKey are set on the client at runtime but missing from @types/pg, so they are read
  // through this one narrow view; both are null until the backend has sent its key data.
  const backend: object = client;
  if (
    !('processID' in backend) ||
    !('secretKey' in backend) ||
    typeof backend.processID !== 'number' ||
    typeof backend.secretKey !== 'number'
  ) {
    logLine('Cannot cancel query: backend key unavailable');
    return Promise.resolve();
  }
  const { processID, secretKey } = backend;
  const message = Buffer.alloc(16);
  message.writeInt32BE(16, 0);
  message.writeInt32BE(CANCEL_REQUEST_CODE, 4);
  message.writeInt32BE(processID, 8);
  message.writeInt32BE(secretKey, 12);

  const { host, port } = client;
  return new Promise<void>((resolve) => {
    const socket = host.startsWith('/') ? net.connect(`${host}/.s.PGSQL.${port}`) : net.connect(port, host);
    // Sent unencrypted, as libpq and pg do (see docs/TODO.md); the timeout keeps a blackholed host from holding the socket.
    socket.setTimeout(5000, () => {
      socket.destroy();
    });
    socket.once('connect', () => {
      socket.end(message);
    });
    socket.once('error', (error) => {
      logLine(`Error sending cancel request: ${error.message}`);
      resolve();
    });
    socket.once('close', () => {
      resolve();
    });
  });
}

function pgPool(config: pg.PoolConfig): PoolLike {
  const pool = new pg.Pool(config);
  pool.on('error', (error) => {
    logLine(`Idle connection pool error: ${error.message}`);
  });
  return {
    async connect() {
      const client = await pool.connect();
      return {
        async query(text, values) {
          const result: pg.QueryResult | pg.QueryResult[] = values
            ? await client.query(text, [...values])
            : await client.query(text);
          return Array.isArray(result) ? result : [result];
        },
        release(destroy) {
          client.release(destroy);
        },
        async cancel() {
          try {
            await sendCancelRequest(client);
          } catch (error) {
            logLine(`Error cancelling query: ${errorMessage(error)}`);
          }
        },
      };
    },
    end: () => pool.end(),
  };
}

/** A factory for real pg pools; `connectTimeoutMs` bounds opening each connection. */
export function createPoolFactory(connectTimeoutMs = CONNECT_TIMEOUT_MS): PoolFactory {
  return (connectionString) => pgPool({ ...poolConfig(connectionString), connectionTimeoutMillis: connectTimeoutMs });
}

export const defaultPoolFactory: PoolFactory = createPoolFactory();

interface ExecutionOptions {
  forceReadonly: boolean;
  statementTimeoutSeconds: number;
  signal: AbortSignal | undefined;
}

interface ErrorContext {
  statementTimeoutSeconds: number;
  signal: AbortSignal | undefined;
  /** performance.now() just before the user query was sent; null if it never was. */
  queryStartedAt: number | null;
}

function mapExecutionError(error: unknown, { statementTimeoutSeconds, signal, queryStartedAt }: ErrorContext): unknown {
  if (signal?.aborted) {
    return new QueryCancelledError({ cause: error });
  }
  // A 57014 is a timeout only when the query ran at least the timeout; any other cancel (e.g. pg_cancel_backend
  // from elsewhere) passes through. Compared by elapsed time, not message text, so it is locale-independent.
  if (
    statementTimeoutSeconds > 0 &&
    error instanceof pg.DatabaseError &&
    error.code === '57014' &&
    queryStartedAt !== null &&
    performance.now() - queryStartedAt >= statementTimeoutSeconds * 1000
  ) {
    logLine(`Query execution timed out after ${statementTimeoutSeconds} seconds`);
    return new QueryTimeoutError(statementTimeoutSeconds, { cause: error });
  }
  return error;
}

async function runUserQuery(
  client: ClientLike,
  query: string,
  params: readonly unknown[] | null | undefined,
  signal: AbortSignal | undefined,
  onSend: () => void
): Promise<QueryResultLike[]> {
  throwIfCancelled(signal);
  const onAbort = () => {
    void client.cancel();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    onSend();
    const results = await (params && params.length > 0 ? client.query(query, params) : client.query(query));
    // A cancel request sent as the query finished can still land on the backend's next statement, so a
    // cancelled call fails here and its connection is destroyed instead of returning to the pool.
    throwIfCancelled(signal);
    return results;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Runs the query in its own transaction on a checked-out client and releases the client. The client goes back to the
 * pool unless the connection may be unusable: a connection-level failure, a failed ROLLBACK, or a cancel after the
 * statement was sent (a late cancel request could hit the backend's next statement).
 */
async function executeWithClient(
  client: ClientLike,
  query: string,
  params: readonly unknown[] | null | undefined,
  options: ExecutionOptions
): Promise<ResultSet> {
  const { forceReadonly, statementTimeoutSeconds, signal } = options;
  // node-postgres runs in autocommit, so a transaction is opened explicitly
  // for every query to keep the closing COMMIT/ROLLBACK meaningful.
  let transactionStarted = false;
  let queryStartedAt: number | null = null;
  let reusable = true;
  try {
    await client.query(forceReadonly ? 'BEGIN TRANSACTION READ ONLY' : 'BEGIN');
    transactionStarted = true;

    if (statementTimeoutSeconds > 0) {
      // Session-level, not SET LOCAL: SET LOCAL ends with the transaction, so unrestricted SQL such as
      // `COMMIT; SELECT pg_sleep(100)` escaped the limit. A session SET survives a user COMMIT within the call,
      // and every call re-issues it.
      await client.query(`SET statement_timeout = ${statementTimeoutSeconds * 1000}`);
    }

    const results = await runUserQuery(client, query, params, signal, () => {
      queryStartedAt = performance.now();
    });
    const last = results.at(-1);

    const result: ResultSet = {
      columns: last ? last.fields.map((field) => field.name) : [],
      rows: last ? last.rows : [],
    };

    await client.query(forceReadonly ? 'ROLLBACK' : 'COMMIT');
    transactionStarted = false;

    return result;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        reusable = false;
        logLine(`Error rolling back transaction: ${errorMessage(rollbackError)}`);
      }
    }
    logLine(`Error executing query: ${errorMessage(error)}`);
    const mapped = mapExecutionError(error, { statementTimeoutSeconds, signal, queryStartedAt });
    // Judged on the original error too: a cancel can mask a connection that died under BEGIN.
    if (
      failureKind(error) === 'connection' ||
      failureKind(mapped) === 'connection' ||
      (mapped instanceof QueryCancelledError && queryStartedAt !== null)
    ) {
      reusable = false;
    }
    throw mapped;
  } finally {
    client.release(!reusable);
  }
}

/** Database connection manager wrapping a node-postgres pool. */
export class DbConnPool {
  connectionUrl: string | undefined;
  #pool: QueuedPool | null = null;
  #isValid = false;
  #lastError: string | null;
  readonly #poolFactory: PoolFactory;
  #connecting: Promise<QueuedPool> | null = null;

  /** `lastError` carries over the error of a pool this one replaces, until a call reaches the database. */
  constructor(connectionUrl?: string, poolFactory: PoolFactory = defaultPoolFactory, lastError: string | null = null) {
    this.connectionUrl = connectionUrl;
    this.#poolFactory = poolFactory;
    this.#lastError = lastError;
  }

  /** The current pool, or null before the first connection and after a failed or closed one. */
  get pool(): QueuedPool | null {
    return this.#pool;
  }

  /** Whether the pool connected and no connection-level failure has invalidated it since. */
  get isValid(): boolean {
    return this.#isValid;
  }

  /** Why the last call could not reach the database, password-masked; null once a call reaches it. */
  get lastError(): string | null {
    return this.#lastError;
  }

  poolConnect(connectionUrl?: string): Promise<QueuedPool> {
    if (this.#pool && this.#isValid) {
      return Promise.resolve(this.#pool);
    }
    // Concurrent callers share one connection attempt.
    if (this.#connecting) {
      return this.#connecting;
    }
    const attempt = this.#connect(connectionUrl).finally(() => {
      if (this.#connecting === attempt) {
        this.#connecting = null;
      }
    });
    this.#connecting = attempt;
    return attempt;
  }

  async #connect(connectionUrl?: string): Promise<QueuedPool> {
    // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- an empty URL falls back to the stored one, as upstream's `or` does
    const url = connectionUrl || this.connectionUrl;
    this.connectionUrl = url;
    if (!url) {
      const error = new Error('Database connection URL not provided');
      this.markInvalid(error);
      throw error;
    }

    // pool.end() waits for every checked-out client, so the old pool is
    // detached and ended in the background instead of blocking the rebuild.
    const stale = this.#pool;
    this.#pool = null;
    this.#isValid = false;
    if (stale) {
      stale.end().catch((error: unknown) => {
        logLine(`Error closing connection pool: ${errorMessage(error)}`);
      });
    }

    try {
      const pool = queuedPool(this.#poolFactory(url), POOL_MAX, POOL_WAIT_TIMEOUT_MS);
      this.#pool = pool;

      const client = await pool.connect();
      try {
        await client.query('SELECT 1');
      } finally {
        client.release();
      }

      this.#isValid = true;
      this.markReachable();
      return pool;
    } catch (error) {
      this.markInvalid(error);
      const message = this.#lastError ?? '';
      await this.close();
      throw new Error(`Connection attempt failed: ${message}`, {
        cause: error,
      });
    }
  }

  async close(): Promise<void> {
    if (this.#pool) {
      try {
        await this.#pool.end();
      } catch (error) {
        logLine(`Error closing connection pool: ${errorMessage(error)}`);
      } finally {
        this.#pool = null;
        this.#isValid = false;
      }
    }
  }

  /** Invalidates the pool after a connection-level failure, so the next call reconnects. */
  markInvalid(error: unknown): void {
    this.#isValid = false;
    this.recordError(error);
  }

  /** Records a connection-level failure, password-masked, without invalidating the pool. */
  recordError(error: unknown): void {
    this.#lastError = maskError(error, this.connectionUrl);
  }

  /** Clears the recorded error once a call has reached the database. */
  markReachable(): void {
    this.#lastError = null;
  }
}

export interface SqlDriverOptions {
  conn?: DbConnPool;
  engineUrl?: string;
  /** Cancels the running statement in Postgres and fails later queries at once. */
  signal?: AbortSignal;
  /** Server-side statement_timeout per query; 0 or undefined means none. */
  statementTimeoutSeconds?: number;
}

/** Adapter that runs queries through a DbConnPool and returns row objects. */
export class SqlDriver {
  conn?: DbConnPool;
  readonly engineUrl: string | undefined;
  readonly signal: AbortSignal | undefined;
  readonly statementTimeoutSeconds: number;

  constructor({ conn, engineUrl, signal, statementTimeoutSeconds }: SqlDriverOptions) {
    this.signal = signal;
    this.statementTimeoutSeconds = statementTimeoutSeconds ?? 0;
    if (conn) {
      this.conn = conn;
    } else if (engineUrl) {
      this.engineUrl = engineUrl;
    } else {
      throw new Error('Either conn or engineUrl must be provided');
    }
  }

  connect(): DbConnPool {
    if (this.conn) {
      return this.conn;
    }
    if (this.engineUrl) {
      this.conn = new DbConnPool(this.engineUrl);
      return this.conn;
    }
    throw new Error('Connection not established. Either conn or engineUrl must be provided');
  }

  get pool(): DbConnPool | undefined {
    return this.conn;
  }

  async executeResultSet(query: string, params?: readonly unknown[] | null, forceReadonly = false): Promise<ResultSet> {
    // Checking before connecting avoids opening a connection for a call that is already cancelled.
    throwIfCancelled(this.signal);
    const conn = this.conn ?? this.connect();
    const client = await this.#checkout(conn);
    try {
      const result = await executeWithClient(client, query, params, {
        forceReadonly,
        statementTimeoutSeconds: this.statementTimeoutSeconds,
        signal: this.signal,
      });
      conn.markReachable();
      return result;
    } catch (error) {
      const kind = failureKind(error);
      if (kind === 'answered') {
        conn.markReachable();
      } else if (kind === 'connection') {
        conn.markInvalid(error);
      }
      throw error;
    }
  }

  /**
   * A client from the connection's pool, or QueryCancelledError as soon as the call is cancelled; the pool's queue
   * owns giving up the wait and releasing a client that arrives late. A failed connection attempt has already
   * invalidated and closed the pool and recorded its error. A checkout failure (credentials, too many connections, a
   * full pool) is recorded but does not invalidate the pool: pg retries new connections itself, and rebuilding a busy
   * pool would only open more connections. A pool closed under a waiting checkout was rebuilt after a failure already
   * recorded, so that is not recorded again. The failure can be a pg.DatabaseError, so it is rewrapped to keep it from
   * passing as the statement's own error, which the tool result reports without isError.
   */
  async #checkout(conn: DbConnPool): Promise<ClientLike> {
    const pool = await untilAborted(conn.poolConnect(), this.signal);
    try {
      return await pool.connect(this.signal);
    } catch (error) {
      if (this.signal?.aborted) {
        throw new QueryCancelledError({ cause: error });
      }
      if (!(error instanceof PoolClosedError)) {
        conn.recordError(error);
      }
      throw new Error(errorMessage(error), { cause: error });
    }
  }
}
