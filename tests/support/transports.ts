import { vi } from 'vitest';

import type { Transports } from '../../src/transports/index.ts';

/** Transport stubs for `main`: each resolves at once, so `main` returns after starting it. */
export function stubTransports() {
  return {
    stdio: vi.fn<Transports['stdio']>().mockResolvedValue(undefined),
    'streamable-http': vi.fn<Transports['streamable-http']>().mockResolvedValue(undefined),
  } satisfies Transports;
}
