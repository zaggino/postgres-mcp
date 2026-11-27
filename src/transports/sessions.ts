import type { ServerResponse } from 'node:http';

export const DEFAULT_MAX_SESSIONS = 100;
export const DEFAULT_SESSION_IDLE_MINUTES = 30;

interface SessionEntry<T> {
  /** Requests being served for the session; its idle timer does not run meanwhile. */
  inFlight: number;
  timer: NodeJS.Timeout | undefined;
  transport: T;
}

function logError(message: string): void {
  process.stderr.write(`ERROR: ${message}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function closeTransport(id: string, transport: { close: () => Promise<void> }): void {
  transport.close().catch((error: unknown) => {
    logError(`Error closing session ${id}: ${errorMessage(error)}`);
  });
}

/**
 * The open sessions of an HTTP transport: the session cap and one idle timer
 * per session. A session is closed after `sessionIdleMinutes` with no request in
 * flight; the timer restarts when the last in-flight request ends. Timers never
 * keep the process alive.
 */
export class SessionStore<T extends { close: () => Promise<void> }> {
  readonly #entries = new Map<string, SessionEntry<T>>();
  readonly #idleMinutes: number;
  readonly #maxSessions: number;

  constructor(options: { maxSessions?: number; sessionIdleMinutes?: number }) {
    this.#maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.#idleMinutes = options.sessionIdleMinutes ?? DEFAULT_SESSION_IDLE_MINUTES;
  }

  get full(): boolean {
    return this.#entries.size >= this.#maxSessions;
  }

  /** Starts tracking a session; it is closed if it stays idle. */
  add(id: string, transport: T): void {
    const entry: SessionEntry<T> = { transport, inFlight: 0, timer: undefined };
    this.#entries.set(id, entry);
    this.#startTimer(id, entry);
  }

  /** The session's transport; looking it up counts as activity and restarts its idle timer. */
  get(id: string): T | undefined {
    const entry = this.#entries.get(id);
    if (entry && entry.inFlight === 0) {
      this.#startTimer(id, entry);
    }
    return entry?.transport;
  }

  /** A request for the session is being served. */
  begin(id: string): void {
    const entry = this.#entries.get(id);
    if (entry) {
      entry.inFlight += 1;
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
  }

  /** A request for the session finished; with none left, the idle timer starts afresh. */
  end(id: string): void {
    const entry = this.#entries.get(id);
    if (entry) {
      entry.inFlight = Math.max(0, entry.inFlight - 1);
      if (entry.inFlight === 0) {
        this.#startTimer(id, entry);
      }
    }
  }

  /** Keeps the session's idle timer stopped until the response closes. */
  hold(id: string, res: ServerResponse): void {
    this.begin(id);
    res.once('close', () => {
      this.end(id);
    });
  }

  remove(id: string): void {
    const entry = this.#entries.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      this.#entries.delete(id);
    }
  }

  async closeAll(): Promise<void> {
    const entries = [...this.#entries.entries()];
    for (const [id] of entries) {
      this.remove(id);
    }
    await Promise.all(
      entries.map(([id, { transport }]) =>
        transport.close().catch((error: unknown) => {
          logError(`Error closing session ${id}: ${errorMessage(error)}`);
        })
      )
    );
  }

  #startTimer(id: string, entry: SessionEntry<T>): void {
    clearTimeout(entry.timer);
    entry.timer = undefined;
    const idleMs = this.#idleMinutes * 60_000;
    if (idleMs <= 0) {
      return;
    }
    entry.timer = setTimeout(() => {
      process.stderr.write(`INFO: Closing session ${id} after ${this.#idleMinutes} idle minute(s)\n`);
      this.remove(id);
      closeTransport(id, entry.transport);
    }, idleMs);
    entry.timer.unref();
  }
}
