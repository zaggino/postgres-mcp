import type { ClientLike, PoolLike } from './sql-driver.ts';

/** pg-pool's message for a checkout that waited too long, kept so callers see the same text. */
export const WAIT_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect';

/** Raised to a checkout still waiting when its pool is closed, for example because it was rebuilt after a failure. */
export class PoolClosedError extends Error {
  constructor() {
    super('Connection pool closed while waiting for a connection');
    this.name = 'PoolClosedError';
  }
}

/** A pool whose checkouts can be abandoned: an aborted `signal` ends the checkout at once, without a client. */
export interface QueuedPool {
  connect: (signal?: AbortSignal) => Promise<ClientLike>;
  end: () => Promise<void>;
}

interface Waiter {
  grant: () => void;
  fail: (error: unknown) => void;
}

/** Rejects once `signal` aborts; never settles otherwise. */
function abortion(signal: AbortSignal | undefined): { promise: Promise<never>; dispose: () => void } {
  const { promise, reject } = Promise.withResolvers<never>();
  const onAbort = () => {
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the abort reason; callers check the signal, not the value
    reject(signal?.reason);
  };
  if (signal?.aborted) {
    onAbort();
  } else {
    signal?.addEventListener('abort', onAbort, { once: true });
  }
  // Keeps a rejection that nobody races against from being reported as unhandled.
  promise.catch(() => {
    // The connect() that created this raced against it and reports the abort.
  });
  return {
    promise,
    dispose: () => {
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * The one owner of waiting for a client. At most `max` clients are checked out of `inner` at once; further checkouts
 * wait here, in order, because pg-pool cannot withdraw a waiting `connect()`. A checkout ends as soon as its `signal`
 * aborts, whether it is still waiting for a slot or `inner` is still opening a connection; a client that arrives
 * after that is released. A checkout that gets no slot within `waitTimeoutMs` fails with pg-pool's timeout message,
 * and `end()` fails the checkouts still waiting with PoolClosedError. `max` must not exceed `inner`'s own size, so
 * `inner` never queues.
 */
export function queuedPool(inner: PoolLike, max: number, waitTimeoutMs: number): QueuedPool {
  let free = max;
  const waiters: Waiter[] = [];

  const releaseSlot = () => {
    const next = waiters.shift();
    if (next) {
      next.grant();
    } else {
      free += 1;
    }
  };

  const acquireSlot = (signal: AbortSignal | undefined): Promise<void> => {
    if (free > 0) {
      free -= 1;
      return Promise.resolve();
    }
    const { promise, resolve, reject } = Promise.withResolvers<undefined>();
    // Settling once ends the wait: a later grant or failure finds the promise settled and does nothing.
    const leave = () => {
      const index = waiters.indexOf(waiter);
      if (index !== -1) {
        waiters.splice(index, 1);
      }
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const waiter: Waiter = {
      grant: () => {
        leave();
        resolve(undefined);
      },
      fail: (error) => {
        leave();
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the abort reason, the timeout Error or PoolClosedError
        reject(error);
      },
    };
    const onAbort = () => {
      waiter.fail(signal?.reason);
    };
    const timer = setTimeout(() => {
      waiter.fail(new Error(WAIT_TIMEOUT_MESSAGE));
    }, waitTimeoutMs);
    timer.unref();
    signal?.addEventListener('abort', onAbort, { once: true });
    waiters.push(waiter);
    return promise;
  };

  const tracked = (client: ClientLike): ClientLike => {
    let released = false;
    return {
      query: (text, values) => client.query(text, values),
      queryArrays: (text) => client.queryArrays(text),
      release(destroy) {
        // A second release still reaches the client, which reports it, but frees no second slot.
        if (released) {
          client.release(destroy);
          return;
        }
        released = true;
        try {
          client.release(destroy);
        } finally {
          releaseSlot();
        }
      },
      cancel: () => client.cancel(),
    };
  };

  return {
    async connect(signal) {
      const aborted = abortion(signal);
      try {
        await Promise.race([acquireSlot(signal), aborted.promise]);
        const opening = inner.connect().catch((error: unknown) => {
          releaseSlot();
          throw error;
        });
        try {
          return tracked(await Promise.race([opening, aborted.promise]));
        } catch (error) {
          if (signal?.aborted) {
            // Abandoned while the connection was opening: hand the client back once it arrives.
            const releaseLate = async () => {
              try {
                tracked(await opening).release();
              } catch {
                // A connection that failed to open has already given its slot back.
              }
            };
            void releaseLate();
          }
          throw error;
        }
      } finally {
        aborted.dispose();
      }
    },
    end: async () => {
      for (let waiter = waiters.shift(); waiter; waiter = waiters.shift()) {
        waiter.fail(new PoolClosedError());
      }
      await inner.end();
    },
  };
}
