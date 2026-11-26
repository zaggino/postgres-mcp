import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AccessMode,
  dbConnection,
  getSqlDriver,
  main,
  runners,
} from "../../src/server.ts";
import { SafeSqlDriver } from "../../src/sql/safe-sql.ts";
import { DbConnPool, SqlDriver } from "../../src/sql/sql-driver.ts";
import { connectClient } from "../support/mcp-client.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("getSqlDriver", () => {
  it.each([
    [AccessMode.UNRESTRICTED, SqlDriver],
    [AccessMode.RESTRICTED, SafeSqlDriver],
  ])("returns the driver for %s mode", (accessMode, expectedType) => {
    const driver = getSqlDriver(accessMode, new DbConnPool());

    expect(driver).toBeInstanceOf(expectedType);
  });

  it("restricted mode applies a 30 second timeout around the base driver", () => {
    const driver = getSqlDriver(AccessMode.RESTRICTED, new DbConnPool());

    expect(driver).toBeInstanceOf(SafeSqlDriver);
    expect(driver).toHaveProperty("timeout", 30);
    expect(driver).toHaveProperty("sqlDriver", expect.any(SqlDriver));
  });

  it("unrestricted mode returns a plain driver without a timeout", () => {
    const driver = getSqlDriver(AccessMode.UNRESTRICTED, new DbConnPool());

    expect(driver).toBeInstanceOf(SqlDriver);
    expect("timeout" in driver).toBe(false);
  });
});

describe("command line access mode", () => {
  it("--access-mode=restricted serves the read-only execute_sql tool", async () => {
    vi.stubEnv("DATABASE_URI", undefined);
    vi.spyOn(dbConnection, "poolConnect").mockResolvedValue({
      connect: vi.fn(),
      end: vi.fn(),
    });
    const runStdio = vi.spyOn(runners, "runStdio").mockResolvedValue();

    await main([
      "postgresql://user:password@localhost/db",
      "--access-mode=restricted",
    ]);

    const factory = runStdio.mock.calls[0]?.[0];
    if (!factory) {
      throw new Error("runStdio was not called");
    }
    const client = await connectClient(factory());
    const { tools } = await client.listTools();
    const executeSql = tools.find((tool) => tool.name === "execute_sql");
    expect(executeSql?.description).toBe("Execute a read-only SQL query");
    expect(executeSql?.annotations?.readOnlyHint).toBe(true);
  });
});
