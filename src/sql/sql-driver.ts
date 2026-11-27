import net from 'node:net';

import type { CustomTypesConfig } from 'pg';
import pg from 'pg';

const INT8_OID = 20;
const URL_PREFIX = /^(?<scheme>[a-zA-Z][a-zA-Z0-9+.-]*):\/\/(?<netloc>[^/?#]*)/u;
const EMBEDDED_URL = /(?<head>postgres(?:ql)?:\/\/[^:]+:)(?<password>[^@]+)(?<tail>@[^/\s]+)/gu;
const PASSWORD_PARAM = /(?<key>password=)(?<value>[^\s&;"']+)/giu;
const DSN_SINGLE_QUOTE = /(?<key>password\s*=\s*')(?<value>[^']+)(?<end>')/giu;
const DSN_DOUBLE_QUOTE = /(?<key>password\s*=\s*")(?<value>[^"]+)(?<end>")/giu;

export interface RowResult {
  cells: Record<string, unknown>;
}

export interface QueryResultLike {
  fields: readonly unknown[];
  rows: Record<string, unknown>[];
}

export interface ClientLike {
  /** One result per statement; a single statement yields a one-element array. */
  query: (text: string, values?: readonly unknown[]) => Promise<QueryResultLike[]>;
  release: (destroy?: boolean) => void;
  /** Asks Postgres to cancel whatever this client's backend is running. Never rejects. */
  cancel: () => Promise<void>;
}

export interface PoolLike {
  connect: () => Promise<ClientLike>;
  end: () => Promise<void>;
}

export type PoolFactory = (connectionString: string) => PoolLike;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logError(message: string): void {
  process.stderr.write(`${message}\n`);
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new QueryCancelledError();
  }
}

/**
 * Waits for `promise` unless `signal` aborts first, in which case it rejects with QueryCancelledError and a value
 * that resolves afterwards goes to `onLate`, so a client checked out after the cancel is still released.
 */
async function untilAborted<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  onLate?: (value: T) => void
): Promise<T> {
  if (!signal) {
    return await promise;
  }
  const aborted = Promise.withResolvers<never>();
  const onAbort = () => {
    aborted.reject(new QueryCancelledError());
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) {
    onAbort();
  }
  try {
    return await Promise.race([promise, aborted.promise]);
  } catch (error) {
    if (error instanceof QueryCancelledError && onLate) {
      promise.then(onLate).catch((lateError: unknown) => {
        logError(`Error after a cancelled wait: ${errorMessage(lateError)}`);
      });
    }
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Whether a failure means the connection itself is unusable, as opposed to Postgres rejecting the statement on a
 * healthy connection. A statement error is a pg.DatabaseError below FATAL outside SQLSTATE class 08 (connection
 * exception); a socket error, an unexpected disconnect or a FATAL/PANIC report is connection-level.
 */
function isConnectionLevelError(error: unknown): boolean {
  if (error instanceof QueryCancelledError) {
    return false;
  }
  const reported = error instanceof QueryTimeoutError ? error.cause : error;
  if (!(reported instanceof pg.DatabaseError)) {
    return true;
  }
  return reported.severity === 'FATAL' || reported.severity === 'PANIC' || (reported.code?.startsWith('08') ?? false);
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

function parseInt8(value: string): number | bigint {
  const asNumber = Number(value);
  return Number.isSafeInteger(asNumber) ? asNumber : BigInt(value);
}

const customTypes: CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') => {
    if (oid === INT8_OID && (format ?? 'text') === 'text') {
      return parseInt8;
    }
    // oxlint-disable-next-line typescript/no-unsafe-return, typescript/no-unsafe-enum-assignment -- pg types the OID as an enum and the parser as any
    return pg.types.getTypeParser(oid, format);
  }) as CustomTypesConfig['getTypeParser'],
};

const CANCEL_REQUEST_CODE = 80_877_102;
const APPLICATION_NAME = 'postgres-mcp';
/** How long a call waits for a free client when all of the pool's connections are busy. */
const POOL_WAIT_TIMEOUT_MS = 30_000;
/** How long opening one new connection may take, so an unreachable database fails fast. */
export const CONNECT_TIMEOUT_MS = 10_000;

/**
 * A pg.Client with its own connect timeout. pg-pool applies `connectionTimeoutMillis` both to waiting for a free
 * client and to opening a new connection; the client's own, shorter timeout fires first for the latter.
 */
function clientWithConnectTimeout(connectTimeoutMs: number): typeof pg.Client {
  return class extends pg.Client {
    constructor(config?: string | pg.ClientConfig) {
      super(typeof config === 'string' ? config : { ...config, connectionTimeoutMillis: connectTimeoutMs });
    }
  };
}

/**
 * Pool config for a connection string. pg lets a connection string's own parameters override config fields but
 * lets config.application_name beat PGAPPNAME, so the default is set only when neither the URI nor PGAPPNAME has one.
 */
export function poolConfig(
  connectionString: string,
  env: NodeJS.ProcessEnv = process.env,
  connectTimeoutMs = CONNECT_TIMEOUT_MS
): pg.PoolConfig {
  let uriHasApplicationName = false;
  try {
    uriHasApplicationName = new URL(connectionString).searchParams.has('application_name');
  } catch {
    // Not a URL; pg parses it its own way and any application_name in it still overrides ours.
  }
  return {
    connectionString,
    max: 5,
    connectionTimeoutMillis: POOL_WAIT_TIMEOUT_MS,
    Client: clientWithConnectTimeout(connectTimeoutMs),
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
    logError('Cannot cancel query: backend key unavailable');
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
      logError(`Error sending cancel request: ${error.message}`);
      resolve();
    });
    socket.once('close', () => {
      resolve();
    });
  });
}

/** A factory for real pg pools; `connectTimeoutMs` bounds opening each connection. */
export const createPoolFactory =
  (connectTimeoutMs = CONNECT_TIMEOUT_MS): PoolFactory =>
  (connectionString) =>
    pgPool(connectionString, connectTimeoutMs);

export const defaultPoolFactory: PoolFactory = createPoolFactory();

function pgPool(connectionString: string, connectTimeoutMs: number): PoolLike {
  const pool = new pg.Pool(poolConfig(connectionString, process.env, connectTimeoutMs));
  pool.on('error', (error) => {
    logError(`Idle connection pool error: ${error.message}`);
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
            logError(`Error cancelling query: ${errorMessage(error)}`);
          }
        },
      };
    },
    end: () => pool.end(),
  };
}

interface ExecutionOptions {
  forceReadonly: boolean;
  statementTimeoutSeconds: number;
  signal: AbortSignal | undefined;
  /** Called when the transaction could not be rolled back, so the connection must not be reused. */
  onRollbackFailed: () => void;
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
    logError(`Query execution timed out after ${statementTimeoutSeconds} seconds`);
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

async function executeWithClient(
  client: ClientLike,
  query: string,
  params: readonly unknown[] | null | undefined,
  options: ExecutionOptions
): Promise<RowResult[] | null> {
  const { forceReadonly, statementTimeoutSeconds, signal } = options;
  // node-postgres runs in autocommit, so a transaction is opened explicitly
  // for every query to keep the closing COMMIT/ROLLBACK meaningful.
  let transactionStarted = false;
  let queryStartedAt: number | null = null;
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

    const rows = last && last.fields.length > 0 ? last.rows : null;

    await client.query(forceReadonly ? 'ROLLBACK' : 'COMMIT');
    transactionStarted = false;

    return rows ? rows.map((row) => ({ cells: { ...row } })) : null;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        options.onRollbackFailed();
        logError(`Error rolling back transaction: ${errorMessage(rollbackError)}`);
      }
    }
    logError(`Error executing query: ${errorMessage(error)}`);
    throw mapExecutionError(error, { statementTimeoutSeconds, signal, queryStartedAt });
  }
}

/** Database connection manager wrapping a node-postgres pool. */
export class DbConnPool {
  connectionUrl: string | undefined;
  pool: PoolLike | null = null;
  isValid = false;
  lastError: string | null = null;
  readonly #poolFactory: PoolFactory;
  #connecting: Promise<PoolLike> | null = null;

  constructor(connectionUrl?: string, poolFactory: PoolFactory = defaultPoolFactory) {
    this.connectionUrl = connectionUrl;
    this.#poolFactory = poolFactory;
  }

  poolConnect(connectionUrl?: string): Promise<PoolLike> {
    if (this.pool && this.isValid) {
      return Promise.resolve(this.pool);
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

  async #connect(connectionUrl?: string): Promise<PoolLike> {
    // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- an empty URL falls back to the stored one, as upstream's `or` does
    const url = connectionUrl || this.connectionUrl;
    this.connectionUrl = url;
    if (!url) {
      this.isValid = false;
      this.lastError = 'Database connection URL not provided';
      throw new Error(this.lastError);
    }

    // pool.end() waits for every checked-out client, so the old pool is
    // detached and ended in the background instead of blocking the rebuild.
    const stale = this.pool;
    this.pool = null;
    this.isValid = false;
    if (stale) {
      stale.end().catch((error: unknown) => {
        logError(`Error closing connection pool: ${errorMessage(error)}`);
      });
    }

    try {
      const pool = this.#poolFactory(url);
      this.pool = pool;

      const client = await pool.connect();
      try {
        await client.query('SELECT 1');
      } finally {
        client.release();
      }

      this.isValid = true;
      this.lastError = null;
      return pool;
    } catch (error) {
      this.markInvalid(error);
      const message = this.lastError ?? '';
      await this.close();
      throw new Error(`Connection attempt failed: ${message}`, {
        cause: error,
      });
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      try {
        await this.pool.end();
      } catch (error) {
        logError(`Error closing connection pool: ${errorMessage(error)}`);
      } finally {
        this.pool = null;
        this.isValid = false;
      }
    }
  }

  /** Invalidates the pool after a connection-level failure, so the next call reconnects. */
  markInvalid(error: unknown): void {
    this.isValid = false;
    this.recordError(error);
  }

  /**
   * Records a connection-level failure without invalidating the pool. An echo of the connection URL is masked as a
   * whole first, because the pattern-based masking can miss a password containing `@` or other unusual characters.
   */
  recordError(error: unknown): void {
    const url = this.connectionUrl;
    const message = url ? errorMessage(error).replaceAll(url, String(obfuscatePassword(url))) : errorMessage(error);
    this.lastError = obfuscatePassword(message) ?? '';
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

  async executeQuery(
    query: string,
    params?: readonly unknown[] | null,
    forceReadonly = false
  ): Promise<RowResult[] | null> {
    // Checking before connecting avoids opening a connection for a call that is already cancelled.
    throwIfCancelled(this.signal);
    const conn = this.conn ?? this.connect();
    // A failed connection attempt has already invalidated and closed the pool and recorded its error.
    const pool = await untilAborted(conn.poolConnect(), this.signal);
    // A checkout failure (credentials, too many connections, a full pool) can be a pg.DatabaseError; rewrapping
    // keeps it from passing as the statement's own error, which the tool result reports without isError. It is
    // recorded but does not invalidate the pool: pg retries new connections itself, and rebuilding a busy pool
    // would only open more connections.
    const client = await untilAborted(pool.connect(), this.signal, (late) => {
      late.release();
    }).catch((error: unknown) => {
      if (error instanceof QueryCancelledError) {
        throw error;
      }
      conn.recordError(error);
      throw new Error(errorMessage(error), { cause: error });
    });
    if (this.signal?.aborted) {
      client.release();
      throw new QueryCancelledError();
    }
    let rollbackFailed = false;
    let destroy = true;
    try {
      const rows = await executeWithClient(client, query, params, {
        forceReadonly,
        statementTimeoutSeconds: this.statementTimeoutSeconds,
        signal: this.signal,
        onRollbackFailed: () => {
          rollbackFailed = true;
        },
      });
      destroy = false;
      conn.lastError = null;
      return rows;
    } catch (error) {
      // A statement Postgres rejected leaves the connection usable once rolled back; a cancelled call's connection
      // is destroyed because a late cancel request could hit its next statement.
      const connectionLevel = isConnectionLevelError(error);
      destroy = connectionLevel || rollbackFailed || error instanceof QueryCancelledError;
      if (connectionLevel) {
        conn.markInvalid(error);
      } else {
        // The database answered, so an earlier connection error no longer applies.
        conn.lastError = null;
      }
      throw error;
    } finally {
      client.release(destroy);
    }
  }
}
