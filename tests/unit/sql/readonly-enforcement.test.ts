import { expect, test } from 'vitest';

import { AccessMode, getSqlDriver } from '../../../src/sql/driver-factory.ts';
import { DbConnPool } from '../../../src/sql/sql-driver.ts';
import { createFakePool, rowsResult } from '../../support/fake-pool.ts';

async function beginStatementFor(accessMode: AccessMode, forceReadonly?: boolean): Promise<string | undefined> {
  const fake = createFakePool(() => [rowsResult([{ test: 'value' }])]);
  const conn = new DbConnPool('postgresql://user:pass@localhost/db', () => fake.pool);
  const driver = getSqlDriver(accessMode, conn, { statementTimeoutSeconds: 0 });

  await driver.executeQuery('SELECT 1', null, forceReadonly);

  return fake.queries[1]?.text;
}

test('unrestricted mode is not read-only by default', async () => {
  await expect(beginStatementFor(AccessMode.UNRESTRICTED)).resolves.toBe('BEGIN');
});

test('unrestricted mode honours forceReadonly=true', async () => {
  await expect(beginStatementFor(AccessMode.UNRESTRICTED, true)).resolves.toBe('BEGIN TRANSACTION READ ONLY');
});

test('unrestricted mode honours forceReadonly=false', async () => {
  await expect(beginStatementFor(AccessMode.UNRESTRICTED, false)).resolves.toBe('BEGIN');
});

test('restricted mode is read-only by default', async () => {
  await expect(beginStatementFor(AccessMode.RESTRICTED)).resolves.toBe('BEGIN TRANSACTION READ ONLY');
});

test('restricted mode stays read-only when forceReadonly=false is passed', async () => {
  await expect(beginStatementFor(AccessMode.RESTRICTED, false)).resolves.toBe('BEGIN TRANSACTION READ ONLY');
});

test('restricted mode stays read-only when forceReadonly=true is passed', async () => {
  await expect(beginStatementFor(AccessMode.RESTRICTED, true)).resolves.toBe('BEGIN TRANSACTION READ ONLY');
});
