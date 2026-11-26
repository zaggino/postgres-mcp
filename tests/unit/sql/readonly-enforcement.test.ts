import { expect, test } from "vitest";
import { AccessMode, getSqlDriver } from "../../../src/server.ts";
import { DbConnPool } from "../../../src/sql/sql-driver.ts";
import { createFakePool, rowsResult } from "../../support/fake-pool.ts";

async function beginStatementFor(
  accessMode: AccessMode,
  forceReadonly?: boolean
): Promise<string | undefined> {
  const fake = createFakePool(() => [rowsResult([{ test: "value" }])]);
  const conn = new DbConnPool(
    "postgresql://user:pass@localhost/db",
    () => fake.pool
  );
  const driver = getSqlDriver(accessMode, conn);

  await driver.executeQuery("SELECT 1", null, forceReadonly);

  return fake.queries[1]?.text;
}

test("unrestricted mode is not read-only by default", async () => {
  expect(await beginStatementFor(AccessMode.UNRESTRICTED)).toBe("BEGIN");
});

test("unrestricted mode honours forceReadonly=true", async () => {
  expect(await beginStatementFor(AccessMode.UNRESTRICTED, true)).toBe(
    "BEGIN TRANSACTION READ ONLY"
  );
});

test("unrestricted mode honours forceReadonly=false", async () => {
  expect(await beginStatementFor(AccessMode.UNRESTRICTED, false)).toBe("BEGIN");
});

test("restricted mode is read-only by default", async () => {
  expect(await beginStatementFor(AccessMode.RESTRICTED)).toBe(
    "BEGIN TRANSACTION READ ONLY"
  );
});

test("restricted mode stays read-only when forceReadonly=false is passed", async () => {
  expect(await beginStatementFor(AccessMode.RESTRICTED, false)).toBe(
    "BEGIN TRANSACTION READ ONLY"
  );
});

test("restricted mode stays read-only when forceReadonly=true is passed", async () => {
  expect(await beginStatementFor(AccessMode.RESTRICTED, true)).toBe(
    "BEGIN TRANSACTION READ ONLY"
  );
});
