import type { ServerResponse } from 'node:http';

import { errorMessage } from '../errors.ts';
import { log } from '../log.ts';

export const DEFAULT_MAX_SESSIONS = 100;
export const DEFAULT_SESSION_IDLE_MINUTES = 30;

interface SessionEntry<T> {
  /** Requests being served for the session; its idle timer does not run meanwhile. */
  inFlight: number;
  timer: NodeJS.Timeout | undefined;
  transport: T;
}

/** Closes a session's transport; a failure is logged, never thrown. */
function closeTransport(id: string, transport: { close: () => Promise<void> }): Promise<void> {
  return transport.close().catch((error: unknown) => {
    log('ERROR', `Error closing session ${id}: ${errorMessage(error)}`);
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

  /** Starts tracking a session, held until `res` closes; after that it is closed if it stays idle. */
  add(id: string, transport: T, res: ServerResponse): void {
    const entry: SessionEntry<T> = { transport, inFlight: 0, timer: undefined };
    this.#entries.set(id, entry);
    this.#hold(id, entry, res);
  }

  /** The session's transport, held until `res` closes; undefined for an unknown id. */
  acquire(id: string, res: ServerResponse): T | undefined {
    const entry = this.#entries.get(id);
    if (entry) {
      this.#hold(id, entry, res);
    }
    return entry?.transport;
  }

  /** Keeps the session's idle timer stopped until the response closes. */
  #hold(id: string, entry: SessionEntry<T>, res: ServerResponse): void {
    entry.inFlight += 1;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    res.once('close', () => {
      this.#end(id);
    });
  }

  /** A request for the session finished; with none left, the idle timer starts afresh. */
  #end(id: string): void {
    const entry = this.#entries.get(id);
    if (entry) {
      entry.inFlight = Math.max(0, entry.inFlight - 1);
      if (entry.inFlight === 0) {
        this.#startTimer(id, entry);
      }
    }
  }

  remove(id: string): void {
    const entry = this.#entries.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      this.#entries.delete(id);
    }
  }

  /** Removes the session and closes its transport, logging a failure to close. */
  close(id: string, transport: T): void {
    this.remove(id);
    void closeTransport(id, transport);
  }

  async closeAll(): Promise<void> {
    const entries = [...this.#entries.entries()];
    for (const [id] of entries) {
      this.remove(id);
    }
    await Promise.all(entries.map(([id, { transport }]) => closeTransport(id, transport)));
  }

  #startTimer(id: string, entry: SessionEntry<T>): void {
    clearTimeout(entry.timer);
    entry.timer = undefined;
    const idleMs = this.#idleMinutes * 60_000;
    if (idleMs <= 0) {
      return;
    }
    entry.timer = setTimeout(() => {
      log('INFO', `Closing session ${id} after ${this.#idleMinutes} idle minute(s)`);
      this.close(id, entry.transport);
    }, idleMs);
    entry.timer.unref();
  }
}
