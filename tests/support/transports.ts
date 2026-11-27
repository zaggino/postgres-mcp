import { vi } from 'vitest';

import type { Transports } from '../../src/main.ts';

/** Transport stubs for `main`: each resolves at once, so `main` returns after starting it. */
export function stubTransports() {
  return {
    runStdio: vi.fn<Transports['runStdio']>().mockResolvedValue(undefined),
    runSse: vi.fn<Transports['runSse']>().mockResolvedValue(undefined),
    runStreamableHttp: vi.fn<Transports['runStreamableHttp']>().mockResolvedValue(undefined),
  };
}
