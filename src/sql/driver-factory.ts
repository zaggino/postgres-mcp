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

/** Server-side statement timeout each access mode applies by default; 0 means none. */
export function defaultStatementTimeoutSeconds(accessMode: AccessMode): number {
  return accessMode === AccessMode.RESTRICTED ? RESTRICTED_TIMEOUT_SECONDS : 0;
}

export interface SqlDriverFactoryOptions {
  signal?: AbortSignal;
  statementTimeoutSeconds?: number;
}

/** Get the appropriate SQL driver for the access mode. */
export function getSqlDriver(
  accessMode: AccessMode,
  conn: DbConnPool,
  { signal, statementTimeoutSeconds = defaultStatementTimeoutSeconds(accessMode) }: SqlDriverFactoryOptions = {}
): SqlExecutor {
  const baseDriver = new SqlDriver({ conn, signal, statementTimeoutSeconds });

  if (accessMode === AccessMode.RESTRICTED) {
    return new SafeSqlDriver(baseDriver);
  }
  return baseDriver;
}
