import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GenericContainer,
  getContainerRuntimeClient,
  ImageName,
  Wait,
} from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe } from "vitest";
import { resetPostgresVersionCache } from "../../src/sql/extension-utils.ts";

const ALL_VERSIONS = ["12", "15", "16"];
const POSTGRES_PASSWORD = "test_password";
const POSTGRES_DB = "test_db";
const CONTEXT_DIR = dirname(fileURLToPath(import.meta.url)).replace(
  /[\\/]support$/u,
  ""
);

/** PostgreSQL major versions under test; `PG_VERSIONS=16` narrows the matrix. */
const versions = (process.env.PG_VERSIONS ?? ALL_VERSIONS.join(","))
  .split(",")
  .map((version) => version.trim())
  .filter(Boolean);

async function isDockerAvailable(): Promise<boolean> {
  try {
    await getContainerRuntimeClient();
    return true;
  } catch {
    return false;
  }
}

const dockerAvailable = await isDockerAvailable();
const requireDocker = process.env.REQUIRE_DOCKER === "1";

const READY_MESSAGE = /database system is ready to accept connections/u;

const imageBuilds = new Map<string, Promise<string>>();

/** Builds `postgres-hypopg:<major>` unless the tag already exists. */
function ensureImage(major: string): Promise<string> {
  const tag = `postgres-hypopg:${major}`;
  const existing = imageBuilds.get(tag);
  if (existing) {
    return existing;
  }
  const build = (async () => {
    const client = await getContainerRuntimeClient();
    if (await client.image.exists(ImageName.fromString(tag))) {
      return tag;
    }
    await GenericContainer.fromDockerfile(
      CONTEXT_DIR,
      "Dockerfile.postgres-hypopg"
    )
      .withBuildArgs({ PG_VERSION: major, PG_MAJOR: major })
      .build(tag, { deleteOnExit: false });
    return tag;
  })();
  imageBuilds.set(tag, build);
  return build;
}

export interface PostgresContext {
  /** Connection string of the container for the current PostgreSQL version. */
  connectionString: () => string;
  /** Major version, e.g. `"16"`. */
  version: string;
}

/**
 * Runs `define` once per PostgreSQL version, each against one container shared
 * by the tests it defines. Skips when Docker is unavailable, unless
 * `REQUIRE_DOCKER=1`, in which case it fails.
 */
export function describeWithPostgres(
  name: string,
  define: (context: PostgresContext) => void
): void {
  for (const version of versions) {
    const suiteName = `${name} [postgres:${version}]`;
    if (!(dockerAvailable || requireDocker)) {
      // biome-ignore lint/suspicious/noSkippedTests: skipping the suite is the documented behaviour without Docker
      describe.skip(suiteName, () => {
        define({
          version,
          connectionString: () => "",
        });
      });
      continue;
    }

    describe(suiteName, () => {
      let container: Awaited<ReturnType<GenericContainer["start"]>> | undefined;
      let connectionString = "";

      beforeAll(async () => {
        if (!dockerAvailable) {
          throw new Error("Docker is not available and REQUIRE_DOCKER=1");
        }
        const image = await ensureImage(version);
        container = await new GenericContainer(image)
          .withEnvironment({
            POSTGRES_PASSWORD,
            POSTGRES_DB,
          })
          .withExposedPorts(5432)
          .withCommand([
            "-c",
            "shared_preload_libraries=pg_stat_statements",
            "-c",
            "pg_stat_statements.track=all",
            "-c",
            "log_statement=all",
          ])
          // The entrypoint starts a temporary server for init scripts first.
          .withWaitStrategy(Wait.forLogMessage(READY_MESSAGE, 2))
          .start();
        connectionString = `postgresql://postgres:${POSTGRES_PASSWORD}@${container.getHost()}:${container.getMappedPort(5432)}/${POSTGRES_DB}`;
      });

      beforeEach(() => {
        resetPostgresVersionCache();
      });

      afterAll(async () => {
        await container?.stop({ timeout: 1 });
      });

      define({ version, connectionString: () => connectionString });
    });
  }
}
