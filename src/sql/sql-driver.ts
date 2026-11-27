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

  constructor(seconds: number, { restricted = false, cause }: { restricted?: boolean; cause?: unknown } = {}) {
    super(
      `Query execution timed out after ${seconds} seconds${restricted ? ' in restricted mode' : ''}. Consider simplifying your query or increasing the timeout.`,
      { cause }
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
    max: 5,
    connectionTimeoutMillis: 30_000,
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

export const defaultPoolFactory: PoolFactory = (connectionString) => {
  const pool = new pg.Pool(poolConfig(connectionString));
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
};

interface ExecutionOptions {
  forceReadonly: boolean;
  statementTimeoutSeconds: number;
  signal: AbortSignal | undefined;
}

function mapExecutionError(error: unknown, { statementTimeoutSeconds, signal }: ExecutionOptions): unknown {
  if (signal?.aborted) {
    return new QueryCancelledError({ cause: error });
  }
  if (statementTimeoutSeconds > 0 && error instanceof pg.DatabaseError && error.code === '57014') {
    logError(`Query execution timed out after ${statementTimeoutSeconds} seconds`);
    return new QueryTimeoutError(statementTimeoutSeconds, { cause: error });
  }
  return error;
}

async function runUserQuery(
  client: ClientLike,
  query: string,
  params: readonly unknown[] | null | undefined,
  signal: AbortSignal | undefined
): Promise<QueryResultLike[]> {
  if (signal?.aborted) {
    throw new QueryCancelledError();
  }
  const onAbort = () => {
    void client.cancel();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const results = await (params && params.length > 0 ? client.query(query, params) : client.query(query));
    // A cancel request sent as the query finished can still land on the backend's next statement, so a
    // cancelled call fails here and its connection is destroyed instead of returning to the pool.
    if (signal?.aborted) {
      throw new QueryCancelledError();
    }
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
  try {
    await client.query(forceReadonly ? 'BEGIN TRANSACTION READ ONLY' : 'BEGIN');
    transactionStarted = true;

    if (statementTimeoutSeconds > 0) {
      await client.query(`SET LOCAL statement_timeout = ${Math.round(statementTimeoutSeconds * 1000)}`);
    }

    const results = await runUserQuery(client, query, params, signal);
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
        logError(`Error rolling back transaction: ${errorMessage(rollbackError)}`);
      }
    }
    logError(`Error executing query: ${errorMessage(error)}`);
    throw mapExecutionError(error, options);
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

  markInvalid(error: unknown): void {
    this.isValid = false;
    this.lastError = obfuscatePassword(errorMessage(error)) ?? '';
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
  conn: DbConnPool | null;
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
      this.conn = null;
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
    return this.conn ?? undefined;
  }

  async executeQuery(
    query: string,
    params?: readonly unknown[] | null,
    forceReadonly = false
  ): Promise<RowResult[] | null> {
    // Checked before the try so a call cancelled before it started does not invalidate the pool.
    if (this.signal?.aborted) {
      throw new QueryCancelledError();
    }
    try {
      const conn = this.conn ?? this.connect();
      const pool = await conn.poolConnect();
      // A checkout failure (credentials, too many connections) can be a pg.DatabaseError; rewrapping keeps it
      // from passing as the statement's own error, which the tool result reports without isError.
      const client = await pool.connect().catch((error: unknown) => {
        throw new Error(errorMessage(error), { cause: error });
      });
      if (this.signal?.aborted) {
        client.release();
        throw new QueryCancelledError();
      }
      let destroy = false;
      try {
        return await executeWithClient(client, query, params, {
          forceReadonly,
          statementTimeoutSeconds: this.statementTimeoutSeconds,
          signal: this.signal,
        });
      } catch (error) {
        destroy = true;
        throw error;
      } finally {
        client.release(destroy);
      }
    } catch (error) {
      // Any failure, including a user syntax error, invalidates the pool.
      this.conn?.markInvalid(error);
      throw error;
    }
  }
}
