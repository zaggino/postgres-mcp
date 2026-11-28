import { logLine } from '../log.ts';
import * as cell from './cells.ts';
import type { SqlExecutor } from './safe-sql.ts';
import { SafeSqlDriver, queryRows } from './safe-sql.ts';
import type { DbConnPool } from './sql-driver.ts';

export type MessageType = 'plain' | 'markdown';

export interface ExtensionStatus {
  defaultVersion: string | null;
  isAvailable: boolean;
  isInstalled: boolean;
  message: string;
  name: string;
}

const INTEGER = /^\s*[+-]?\d+\s*$/u;

// Major version per connection pool; an executor without a pool is its own key.
let versions = new WeakMap<DbConnPool | SqlExecutor, number>();

/** Read it after the first query too: a driver built from a URL creates its pool lazily. */
function cacheKey(sqlDriver: SqlExecutor): DbConnPool | SqlExecutor {
  return sqlDriver.pool ?? sqlDriver;
}

/** Reset the PostgreSQL version cache. Primarily used for testing. */
export function resetPostgresVersionCache(): void {
  versions = new WeakMap();
}

/**
 * Get the major PostgreSQL version as an integer (e.g. 16 for PostgreSQL 16.2).
 * Returns 0 if the version cannot be determined.
 */
export async function getPostgresVersion(sqlDriver: SqlExecutor): Promise<number> {
  const cached = versions.get(cacheKey(sqlDriver));
  if (cached !== undefined) {
    return cached;
  }

  try {
    const rows = await queryRows(sqlDriver, 'SHOW server_version');
    const [first] = rows;
    if (!first) {
      logLine('Could not determine PostgreSQL version');
      return 0;
    }

    const versionString = cell.text(first, 'server_version');
    // Extract the major version (before the first dot)
    const majorVersion = versionString.split('.')[0] ?? '';
    if (!INTEGER.test(majorVersion)) {
      throw new Error(`Invalid PostgreSQL version: ${versionString}`);
    }
    const version = Number.parseInt(majorVersion, 10);

    versions.set(cacheKey(sqlDriver), version);
    return version;
  } catch (error) {
    throw new Error('Error determining PostgreSQL version', { cause: error });
  }
}

/** Returns `[meetsRequirement, message]`. */
export async function checkPostgresVersionRequirement(
  sqlDriver: SqlExecutor,
  minVersion: number,
  featureName: string
): Promise<[boolean, string]> {
  const pgVersion = await getPostgresVersion(sqlDriver);

  if (pgVersion >= minVersion) {
    return [true, `PostgreSQL version ${pgVersion} meets the requirement for ${featureName}`];
  }

  return [
    false,
    `This feature (${featureName}) requires PostgreSQL ${minVersion} or later. Your current version is PostgreSQL ${pgVersion || 'unknown'}.`,
  ];
}

function installedMessage(name: string, version: string, messageType: MessageType): string {
  return messageType === 'markdown'
    ? `The **${name}** extension (version ${version}) is already installed.`
    : `The ${name} extension (version ${version}) is already installed.`;
}

function availableMessage(name: string, messageType: MessageType): string {
  return messageType === 'markdown'
    ? `The **${name}** extension is available but not installed.\n\n` +
        `You can install it by running: \`CREATE EXTENSION ${name};\`.`
    : `The ${name} extension is available but not installed.\n` +
        `You can install it by running: CREATE EXTENSION ${name};`;
}

function unavailableMessage(name: string, messageType: MessageType): string {
  return messageType === 'markdown'
    ? `The **${name}** extension is not available on this PostgreSQL server.\n\n` +
        'To install it, you need to:\n' +
        '1. Install the extension package on the server\n' +
        `2. Run: \`CREATE EXTENSION ${name};\``
    : `The ${name} extension is not available on this PostgreSQL server.\n` +
        'To install it, you need to:\n' +
        '1. Install the extension package on the server\n' +
        `2. Run: CREATE EXTENSION ${name};`;
}

/** Check if a PostgreSQL extension is installed or available. */
export async function checkExtension(
  sqlDriver: SqlExecutor,
  extensionName: string,
  includeMessages = true,
  messageType: MessageType = 'plain'
): Promise<ExtensionStatus> {
  const installedResult = await SafeSqlDriver.executeParamQuery(
    sqlDriver,
    'SELECT extversion FROM pg_extension WHERE extname = {}',
    [extensionName]
  );

  const result: ExtensionStatus = {
    isInstalled: false,
    isAvailable: false,
    name: extensionName,
    message: '',
    defaultVersion: null,
  };

  const [installed] = installedResult;
  if (installed) {
    const version = cell.text(installed, 'extversion');
    result.isInstalled = true;
    result.isAvailable = true;

    if (includeMessages) {
      result.message = installedMessage(extensionName, version, messageType);
    }
    return result;
  }

  const availableResult = await SafeSqlDriver.executeParamQuery(
    sqlDriver,
    'SELECT default_version FROM pg_available_extensions WHERE name = {}',
    [extensionName]
  );

  const [available] = availableResult;
  if (available) {
    result.isAvailable = true;
    result.defaultVersion = cell.nullableText(available, 'default_version');

    if (includeMessages) {
      result.message = availableMessage(extensionName, messageType);
    }
  } else if (includeMessages) {
    result.message = unavailableMessage(extensionName, messageType);
  }

  return result;
}

/** Returns `[isInstalled, message]` with installation instructions for HypoPG. */
export async function checkHypopgInstallationStatus(
  sqlDriver: SqlExecutor,
  messageType: MessageType = 'markdown'
): Promise<[boolean, string]> {
  const status = await checkExtension(sqlDriver, 'hypopg', false);

  if (status.isInstalled) {
    return messageType === 'markdown'
      ? [true, 'The **hypopg** extension is already installed.']
      : [true, 'The hypopg extension is already installed.'];
  }

  if (status.isAvailable) {
    if (messageType === 'markdown') {
      return [
        false,
        'The **hypopg** extension is required to test hypothetical indexes, but it is not currently installed.\n\n' +
          "You can ask me to install 'hypopg' using the 'execute_query' tool.\n\n" +
          "**Is it safe?** Installing 'hypopg' is generally safe and a standard practice for index testing. " +
          'It adds a virtual layer that simulates indexes without actually creating them in the database. ' +
          'It requires database privileges (often superuser) to install.\n\n' +
          '**What does it do?** It allows you to create virtual indexes and test how they would affect query performance ' +
          'without the overhead of actually creating the indexes.\n\n' +
          "**How to undo?** If you later decide to remove it, you can ask me to run 'DROP EXTENSION hypopg;'.",
      ];
    }
    return [
      false,
      'The hypopg extension is required to test hypothetical indexes, but it is not currently installed.\n' +
        "You can ask me to install it using the 'execute_query' tool.\n" +
        'It is generally safe to install and allows testing indexes without creating them.',
    ];
  }

  const pgVersion = await getPostgresVersion(sqlDriver);
  const majorVersion = pgVersion > 0 ? `${pgVersion}` : 'XX';
  // Extension is not available
  if (messageType === 'markdown') {
    return [
      false,
      'The **hypopg** extension is not available on this PostgreSQL server.\n\n' +
        'To install HypoPG:\n' +
        `1. For Debian/Ubuntu: \`sudo apt-get install postgresql-${majorVersion}-hypopg\`\n` +
        `2. For RHEL/CentOS: \`sudo yum install postgresql${majorVersion}-hypopg\`\n` +
        '3. For MacOS with Homebrew: `brew install hypopg`\n' +
        '4. For other systems, build from source: `git clone https://github.com/HypoPG/hypopg`\n\n' +
        'After installing the extension packages, connect to your database and run: `CREATE EXTENSION hypopg;`',
    ];
  }
  return [
    false,
    'The hypopg extension is not available on this PostgreSQL server.\n' +
      'To install HypoPG:\n' +
      `1. For Debian/Ubuntu: sudo apt-get install postgresql-${majorVersion}-hypopg\n` +
      `2. For RHEL/CentOS: sudo yum install postgresql${majorVersion}-hypopg\n` +
      '3. For MacOS with Homebrew: brew install hypopg\n' +
      '4. For other systems, build from source: git clone https://github.com/HypoPG/hypopg\n' +
      'After installing the extension packages, connect to your database and run: CREATE EXTENSION hypopg;',
  ];
}
