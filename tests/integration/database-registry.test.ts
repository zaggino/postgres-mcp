import { afterAll, beforeAll, expect, test } from 'vitest';

import { DatabaseRegistry } from '../../src/database-registry.ts';
import { AccessMode, defaultStatementTimeoutSeconds } from '../../src/sql/driver-factory.ts';
import { defaultPoolFactory } from '../../src/sql/sql-driver.ts';
import { describeWithPostgres } from '../support/postgres.ts';

const DATABASES = ['mcp_disc_a', 'mcp_disc_b', 'mcp_disc_noconn'];

/** Runs statements outside a transaction; CREATE and DROP DATABASE cannot run inside one. */
async function runAdmin(connectionString: string, statements: string[]): Promise<void> {
  const pool = defaultPoolFactory(connectionString);
  const client = await pool.connect();
  try {
    for (const statement of statements) {
      await client.query(statement);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

describeWithPostgres('DatabaseRegistry discovery', ({ connectionString }) => {
  let registry: DatabaseRegistry;

  beforeAll(async () => {
    await runAdmin(connectionString(), [
      ...DATABASES.flatMap((name) => [`DROP DATABASE IF EXISTS ${name}`, `CREATE DATABASE ${name}`]),
      'ALTER DATABASE mcp_disc_noconn ALLOW_CONNECTIONS false',
    ]);
    registry = new DatabaseRegistry({
      accessMode: AccessMode.RESTRICTED,
      idleMinutes: 10,
      statementTimeoutSeconds: defaultStatementTimeoutSeconds(AccessMode.RESTRICTED),
      databases: [],
      servers: [{ uri: { uri: connectionString() }, prefix: 'x-', include: ['mcp_disc_*'], exclude: [] }],
    });
  });

  afterAll(async () => {
    await registry.closeAll();
    await runAdmin(
      connectionString(),
      DATABASES.flatMap((name) => [`ALTER DATABASE ${name} ALLOW_CONNECTIONS true`, `DROP DATABASE IF EXISTS ${name}`])
    );
  });

  test('lists databases that allow connections and connects to each by its prefixed name', async () => {
    const { databases } = await registry.list();
    expect(databases.map((entry) => entry.database)).toEqual(['x-mcp_disc_a', 'x-mcp_disc_b']);

    const rows = await registry.use('x-mcp_disc_a', (driver) => driver.executeQuery('SELECT current_database() AS db'));
    expect(rows[0]?.db).toBe('mcp_disc_a');
  });
});
