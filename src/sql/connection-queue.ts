import type { ClientLike, PoolLike } from './sql-driver.ts';

/** pg-pool's message for a checkout that waited too long, kept so callers see the same text. */
export const WAIT_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect';

interface Waiter {
  grant: () => void;
  reject: (error: unknown) => void;
}

/**
 * A pool that lets at most `max` clients be checked out of `inner` at once and queues further checkouts itself, in
 * order. pg-pool cannot withdraw a waiting `connect()`, so a cancelled call would otherwise hold its place in pg-pool's
 * queue until a client freed up; here an aborted `signal` removes the waiter at once. A waiter that gets no slot within
 * `waitTimeoutMs` fails with pg-pool's timeout message. `max` must not exceed the inner pool's own size, so the inner
 * pool never queues.
 */
export function queuedPool(inner: PoolLike, max: number, waitTimeoutMs: number): PoolLike {
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
    if (signal?.aborted) {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the abort reason, so the caller can tell its own cancel apart
      return Promise.reject(signal.reason);
    }
    if (free > 0) {
      free -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const leave = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const index = waiters.indexOf(waiter);
        if (index !== -1) {
          waiters.splice(index, 1);
        }
      };
      const waiter: Waiter = {
        grant: () => {
          leave();
          resolve();
        },
        reject: (error) => {
          leave();
          // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the abort reason or the timeout Error
          reject(error);
        },
      };
      const onAbort = () => {
        waiter.reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        waiter.reject(new Error(WAIT_TIMEOUT_MESSAGE));
      }, waitTimeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      waiters.push(waiter);
    });
  };

  return {
    async connect(signal) {
      await acquireSlot(signal);
      let client: ClientLike;
      try {
        client = await inner.connect(signal);
      } catch (error) {
        releaseSlot();
        throw error;
      }
      let released = false;
      return {
        query: (text, values) => client.query(text, values),
        release(destroy) {
          if (!released) {
            released = true;
            client.release(destroy);
            releaseSlot();
          }
        },
        cancel: () => client.cancel(),
      };
    },
    end: () => inner.end(),
  };
}
