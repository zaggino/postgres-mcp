import { afterEach, expect, it as test, vi } from 'vitest';

import { SessionStore } from '../../src/transports/sessions.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('a session whose first response closed before it was added still closes after the idle time', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const transport = { close: vi.fn(() => Promise.resolve()) };
  const store = new SessionStore<typeof transport>({ sessionIdleMinutes: 1, maxSessions: 1 });

  store.add('s', transport, { closed: true, once: vi.fn() });
  await vi.advanceTimersByTimeAsync(60_001);

  expect(transport.close).toHaveBeenCalledOnce();
  expect(store.full).toBe(false);
});
