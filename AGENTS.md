# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## What this is

`@zaggino/postgres-mcp` is a PostgreSQL MCP server (index tuning, explain plans, health checks, SQL execution). It started as a TypeScript port of the Python server at https://github.com/crystaldba/postgres-mcp and now evolves independently; upstream is a reference, not a specification. Nothing is published as a Docker image; the only artifact is the npm package with the `postgres-mcp` binary.

## Commands

Node >= 26, pnpm 12 (`packageManager` in `package.json`).

| Command                   | Purpose                                    |
| ------------------------- | ------------------------------------------ |
| `pnpm check` / `pnpm fix` | Ultracite on oxlint + oxfmt (not Biome)    |
| `pnpm typecheck`          | `tsc --noEmit`                             |
| `pnpm build`              | tsdown to `dist/`                          |
| `pnpm test:unit`          | Vitest project `unit`                      |
| `pnpm test:integration`   | Vitest project `integration`; needs Docker |

- One file: `pnpm vitest run --project unit tests/unit/sql/safe-sql.test.ts`. One test: add `-t "<name>"`.
- Integration tests build `tests/Dockerfile.postgres-hypopg` and run every file against Postgres 12, 15 and 16 through testcontainers (`tests/support/postgres.ts`). `PG_VERSIONS=16` limits the versions. Without Docker the tests skip, unless `REQUIRE_DOCKER=1` (set in CI). They are slow and run files serially: run them alone.
- On Windows, start Vitest from a path with an uppercase drive letter (`/D/dev/...`). From a lowercase one it fails with "failed to find the current suite".
- `pnpm install` installs lefthook git hooks (`lefthook.yml`): pre-commit runs `ultracite check` on the staged files, pre-push runs typecheck and build.
- CI (`.github/workflows/build.yml`) runs check, typecheck, build, unit, integration, in that order.
- Run from source: `pnpm build && MCP_APP_DATABASE_URI=postgresql://... node dist/index.js --database=app --access-mode=restricted`.

## Architecture

`src/index.ts` is the bin entry and only calls `main()` in `src/main.ts`.

**`src/main.ts`** is startup and shutdown: `main(argv, transports)` parses the CLI, builds the `DatabaseRegistry` and installs the SIGTERM/SIGINT handlers. It then logs the startup warning for a non-loopback host (`warnIfExposed`) and starts the transport named by `--transport` from a `Transports` set (`src/transports/index.ts`, `defaultTransports`), taking the HTTP transport's options from `httpOptions` in `src/cli.ts`. `shutdown` closes the registry and exits. Startup makes no database connection; an unreachable or unconfigured database is reported by the tool call or `list_databases`. The `transports` parameter is the test seam.

**`src/server.ts`** holds the MCP surface: `createServer(registry)` registers the nine database tools plus `list_databases` and (unrestricted mode only) `cancel_query`, with their zod schemas. The database tools go through `registerDatabaseTool`, which adds the required `database` argument, runs the body through `registry.use(name, ...)` and turns its failures into `Error:` results; every tool except `list_databases` and `cancel_query` therefore takes a required `database` argument, and the server `instructions` say so. The tool bodies live in `src/tools/` (`objects.ts` for the listing tools, `analysis.ts` for the rest), and `src/server-instructions.ts` builds the server `instructions` (`serverInstructions`). `src/tools/result.ts` has `toJson` and `formatError` (sets `isError` unless the error, or an `ErrorResult`'s `cause`, is a statement error per `isStatementError` in `src/sql/sql-driver.ts`, a `pg.DatabaseError` that is not FATAL or a connection SQLSTATE; `SqlDriver.executeResultSet` rewraps connection checkout failures so they never pass as one; the same classification decides whether the driver reuses the connection and keeps the pool valid).

**`src/transports/`** holds the three transports (SSE and streamable HTTP on `node:http`): `stdio.ts`, `sse.ts`, `streamable-http.ts`, `index.ts` (`Transports`, `defaultTransports`), and the plumbing they share: `http.ts` (listening behind the request guard and closing sessions then server, `HttpServerHandle`, `parseRequestUrl`; body reading and JSON-RPC errors live in `streamable-http.ts`), `request-guard.ts` (loopback hosts, `HttpServerOptions`, the `--allowed-hosts`/`--allowed-origins` allow-lists and their validation, the Host and Origin check on every request), `sessions.ts` (`SessionStore`: session cap, idle timer paused while a request is in flight, `hold` for the life of a response, `close(id, transport)` to remove and close a session) and `types.ts` (`ServerFactory`).

**`src/cli.ts`** owns CLI parsing: the flags (`parseCli`), `USAGE` and `HELP`, `CliError` and `exitOnCliError`, and `httpOptions`, the one mapping from the flags of an HTTP transport (`HttpTransport`) to `HttpServerOptions`.

**`src/config.ts`** turns the CLI flags (`--database`, `--config`, `--idle-minutes`, `--access-mode`) and the optional JSONC config file (`jsonc-parser`, then zod, strict) into `DatabaseRegistry` options. `${VAR}` expansion happens there; an unset variable becomes a per-entry error, not a startup failure.

**`src/database-registry.ts`** is the `DatabaseRegistry`, which owns the access mode and builds every driver: tools call `registry.use(name, fn(sqlDriver))`, and its `getSqlDriver` option replaces the driver factory in tests. It holds a lazily created `DbConnPool` per database (`src/sql/sql-driver.ts`; it puts `queuedPool` from `src/sql/connection-queue.ts` in front of the pg pool, which owns waiting for a client, the 30 s wait and cancelling a wait), closed after `idleMinutes` with no call in flight, plus discovery of databases on config `servers` (`pg_database` query, include/exclude globs, prefix). Discovery re-runs on `list_databases` and on an unknown name.

**Access modes decide the driver.** `getSqlDriver()` (`src/sql/driver-factory.ts`) returns a plain `SqlDriver` in unrestricted mode and a `SafeSqlDriver` wrapping it in restricted mode. Every tool goes through it, so restricted mode constrains the health, explain and index tools too, not just `execute_sql`.

**Restricted mode** (`src/sql/safe-sql.ts`, `src/sql/allowlists.ts`) parses each statement with `libpg-query` and walks the JSON tree default-deny: statement types, node types, functions and extensions must all be on an allowlist. Accepted SQL is prefixed with `/* postgres-mcp */` and run in `BEGIN TRANSACTION READ ONLY` with a server-side `statement_timeout` (30 s by default). The allowlists started as upstream's and are now maintained here; adding an entry is a security decision, and a new entry carries its reason in a comment in `src/sql/allowlists.ts`. A node type or function missing from them is rejected by design, so adding SQL to an internal query can make it fail in restricted mode only.

**SQL building.** Internal queries use `{}` placeholders filled by `SafeSqlDriver.executeParamQuery` through `src/sql/literal.ts` (literal, identifier and array quoting), not `pg` bind parameters. Multi-statement strings go through the simple protocol and the last result is used. `SqlExecutor` has one method, `executeResultSet`, which returns the last result's `{ columns, rows }` (`ResultSet` and `Row` in `src/sql/sql-driver.ts`); callers that only need rows use `queryRows` (`src/sql/safe-sql.ts`), and only `execute_sql` looks at the columns.

**AST layer** (`src/sql/pg-ast.ts`). `libpg-query` returns `{ NodeType: {...} }` JSON. `AstNode` and `Visitor` reproduce pglast's traversal (visit method first, then default descent) because the index advisor's visitors in `src/sql/bind-params.ts` and `src/index/dta-calc.ts` were ported against that order. The WASM parser must be loaded (`loadParser()`) before `parseSqlSync` is used.

**Index advisor** (`src/index/`). `IndexTuningBase` (`index-opt-base.ts`) gathers the workload (from `pg_stat_statements` or given queries), costs configurations with `hypopg` hypothetical indexes and `EXPLAIN`, and produces the result; `DatabaseTuningAdvisor` (`dta-calc.ts`) supplies candidate generation and the greedy search; `presentation.ts` turns the result into the tool's JSON. Hypothetical indexes are named `postgres_mcp_idx_*`. The `method` tool parameter accepts only `"dta"`.

**Other tools.** `src/database-health/` has one calculator per health area, combined by `database-health.ts`. `src/explain/explain-plan.ts` and `src/artifacts.ts` build and diff explain plans. `src/top-queries/` reads `pg_stat_statements`, with column names that differ by server version (`src/sql/extension-utils.ts` caches the version per connection pool).

## Conventions specific to this repo

- **The tool surface is a published interface.** Tool names, parameter names (snake_case), defaults, descriptions and CLI flags may change when that improves the tools. `tests/unit/server-surface.test.ts` pins the tool names, parameters, defaults and annotations and changes with them; it does not pin descriptions or CLI flags, though other tests assert some of them. Another project caches the schemas, so a change an existing caller or cached schema would break on is breaking: a renamed or removed tool, parameter or CLI flag, a newly required parameter, a changed default, a narrowed type, or a changed shape or type in the JSON a tool returns. A change to the wording of text output is not breaking. Commit a breaking change as `feat!` (or with a `BREAKING CHANGE:` footer); release-please then bumps the major version (the first release is 1.0.0).
- **Upstream is a reference.** Behaviour, messages and SQL text may differ from the Python original. A defect inherited from upstream is a bug like any other: fix it, or record it in `docs/TODO.md` (see Follow-ups below) when the fix is not part of the change.
- **Keep "Differences from upstream" current.** The "Differences from upstream" section of `README.md` lists the differences someone moving from upstream would notice: the tool surface, CLI flags, defaults, security behaviour and output format. A change that adds or removes such a difference updates that section in the same change; an individual bug fix or a change of message wording does not.
- **Keep the server instructions current.** `serverInstructions` in `src/server-instructions.ts` tells every connected agent how the server behaves: the access mode and its timeout, cancellation, which failures set `isError`, how to diagnose a failure, discovered-name prefixes, and where to report issues. A change that makes any of it wrong, or adds behaviour an agent needs to know to use the tools, updates the instructions in the same change. Keep each clause one short sentence; the text costs tokens in every session.
- **Output format.** Structured tool results are JSON. The existing Python-style formatting goes through `src/py-format.ts` (`naturalSize` is base 1000) until it is replaced (see `docs/TODO.md`); new output need not imitate Python.
- **Shared helpers.** Use `errorMessage` (`src/errors.ts`), `isJsonObject` (`src/json.ts`) and the number formatters `formatFixed` and `formatPercent` (`src/py-format.ts`) instead of local copies; `pyTypeName`, `pyFloatStr` and `naturalSize` there are legacy and not for new code. Every stderr line goes through `src/log.ts`: a new message uses `log(level, ...)`; `logLine` writes a line without a level prefix and serves only the existing unprefixed lines.
- **Value types from `pg`.** The pool's parsers (`src/sql/type-parsers.ts`) keep values as Postgres sends them: `int8` (and `int8[]`) is parsed to `number` when safe and `bigint` otherwise; `numeric`, `numeric[]`, the date and time types, `interval`, `bytea` and the geometric types stay text; `json`/`jsonb` go through `parseJsonLossless` (`src/json.ts`), which keeps a number a double cannot hold as a raw JSON value. `toJson` (`src/json.ts`) writes a `bigint` as an exact JSON number and a non-finite float as `"NaN"`, `"Infinity"` or `"-Infinity"`; tool output that contains row values goes through it, and `isJsonObject` rejects raw JSON values. No reader produces a `Date`.
- **Reading rows.** Map each query's rows to a named interface at the query with the strict readers in `src/sql/cells.ts` (`import * as cell`, then `cell.text(row, 'col')`, `cell.nullableInteger(...)`, `cell.single(rows)` for a one-row result, and so on); they throw `CellError` on a missing column or an unexpected kind. A cell is never decoded with `String()`, `Number()` or `Boolean()` (`cell.numeric` is the one reader that parses `numeric` text), but converting a value a reader already returned is fine, e.g. `Number(cell.int8(...))` for a weight.
- **Tests replace seams, not modules.** `createTestRegistry` (`tests/support/registry.ts`) takes a `getSqlDriver` option to swap the driver, and `main` in `src/main.ts` takes a `Transports` argument (type in `src/transports/index.ts`) to swap the transports, with `stubTransports()` in `tests/support/transports.ts`; unit tests use `tests/support/fake-pool.ts` for `pg` and `tests/support/mcp-client.ts` to drive the server as a client.
- **Dependencies are pinned exactly** (`saveExact: true` in `pnpm-workspace.yaml`); Dependabot opens one grouped PR at a time.
- **Lint config.** Linting is type-aware (`options.typeAware`, run by the `oxlint-tsgolint` engine against `tsconfig.json`). `oxlint.config.ts` switches off about 40 preset rules, each with its reason in a comment; a targeted exception is an inline `oxlint-disable-next-line <rule> -- <reason>`. Vitest preset rules can only be switched off through `disabledVitestRules` there, not through a top-level `rules` entry.
- TypeScript is strict with `noUncheckedIndexedAccess`, `verbatimModuleSyntax` and `.ts` import extensions; no `any` and no non-null assertions.
- Releases come from release-please (`.github/workflows/release-please.yml`, `release-please-config.json`): Conventional Commits on `main` drive the version and `CHANGELOG.md` of an open release PR, and merging it tags and publishes. Never tag or bump the version by hand; `SERVER_VERSION` is read from `package.json`. A failed npm publish is retried by dispatching the workflow from `main` with `publish`.

## Follow-ups

Record every follow-up found while working on a change — a known issue to defer, tech debt, missing tests or docs, a tooling gap — in `docs/TODO.md` in the same change.

`docs/TODO.md` tracks only open work. **When a follow-up is resolved, delete its entry.** Do not check it off, mark it done or strike it through; resolved items live in git history.

**Entry format.** Each entry is its own `##` heading of the form `## YYYY-MM-DD · <Priority> · <Type> · <short title>`, covering one issue, with the detail in the body below it: what happens, where in the code, and why it matters. The date is the day the entry was written.

`<Priority>` is how soon it matters:

- `Critical` — broken production behaviour, data loss or corruption, an exploitable security hole, or blocked work.
- `Major` — a real defect or gap worth scheduling soon.
- `Minor` — low impact; worth doing when nearby.

`<Type>` is the kind of work: `Security`, `Bug`, `Feature`, `Performance`, `Refactor`, `Tests`, `Tooling`, `Infra`, `Observability`, `Dependencies`, `Docs` or `Other`.

**Breaking changes.** When resolving an entry requires a breaking change (see "The tool surface is a published interface"), the first line of its body is `_BREAKING CHANGE REQUIRED_`, alone in its own paragraph. Tag the entry when you write it, and add or remove the tag when the planned fix changes. An entry whose fix can keep the surface and the output shape is not tagged.

Do not record trivial items (cosmetic wording, speculative polish). Do not group entries under section headings or priority tiers, do not use checkboxes, and do not add a separate type or category line to the body.

**Append only.** Add new entries at the end of the file, so it stays sorted oldest first. Never insert an entry above an existing one and never change an entry's date; its priority and type may be updated. When two branches both append, resolve the conflict by keeping both entries in date order.

## Lessons learned

When the user corrects a mistake you made — about this codebase, their preferences, or a general technical point — append one line to this section before continuing the task. Write it as a rule for future work, not as an account of what happened.
