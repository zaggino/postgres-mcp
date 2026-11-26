import { expect, test } from "vitest";
import { DbConnPool, SqlDriver } from "../../../src/sql/sql-driver.ts";
import { createFakePool, rowsResult } from "../../support/fake-pool.ts";

// Only the UNRESTRICTED half of the Python test is portable here: the
// RESTRICTED half goes through the server's access mode and SafeSqlDriver,
// which are ported in later steps.
async function beginStatementFor(
  forceReadonly?: boolean
): Promise<string | undefined> {
  const fake = createFakePool(() => [rowsResult([{ test: "value" }])]);
  const conn = new DbConnPool(
    "postgresql://user:pass@localhost/db",
    () => fake.pool
  );
  const driver = new SqlDriver({ conn });

  await driver.executeQuery("SELECT 1", null, forceReadonly);

  return fake.queries[1]?.text;
}

test("executeQuery is not read-only by default", async () => {
  expect(await beginStatementFor()).toBe("BEGIN");
});

test("executeQuery honours forceReadonly=true", async () => {
  expect(await beginStatementFor(true)).toBe("BEGIN TRANSACTION READ ONLY");
});

test("executeQuery honours forceReadonly=false", async () => {
  expect(await beginStatementFor(false)).toBe("BEGIN");
});
