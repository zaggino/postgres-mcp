import type { SqlExecutor } from './safe-sql.ts';
import { SafeSqlDriver } from './safe-sql.ts';
import type { DbConnPool } from './sql-driver.ts';
import { SqlDriver } from './sql-driver.ts';

export const RESTRICTED_TIMEOUT_SECONDS = 30;

export const ACCESS_MODES = ['unrestricted', 'restricted'] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];
export const AccessMode = {
  UNRESTRICTED: 'unrestricted',
  RESTRICTED: 'restricted',
} as const satisfies Record<string, AccessMode>;
export const DEFAULT_ACCESS_MODE: AccessMode = AccessMode.RESTRICTED;

/** Get the appropriate SQL driver for the access mode. */
export function getSqlDriver(accessMode: AccessMode, conn: DbConnPool): SqlExecutor {
  const baseDriver = new SqlDriver({ conn });

  if (accessMode === AccessMode.RESTRICTED) {
    return new SafeSqlDriver(baseDriver, RESTRICTED_TIMEOUT_SECONDS);
  }
  return baseDriver;
}
