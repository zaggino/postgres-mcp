# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## What this is

`@zaggino/postgres-mcp` is a PostgreSQL MCP server (index tuning, explain plans, health checks, SQL execution). It is a TypeScript port of the Python server at https://github.com/crystaldba/postgres-mcp, kept behaviour-compatible with it. Nothing is published as a Docker image; the only artifact is the npm package with the `postgres-mcp` binary.

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

`src/index.ts` is the bin entry and only calls `main()` in `src/server.ts`.

**`src/server.ts`** holds the whole MCP surface: the nine tool registrations plus `list_databases` with their zod schemas (`createServer(registry)`), the three transports (stdio, SSE, streamable HTTP, all on `node:http` with a Host-header guard), and shutdown. Every tool except `list_databases` takes a required `database` argument and runs through `registry.use(name, ...)`; the server `instructions` say so. Startup makes no database connection; an unreachable or unconfigured database is reported by the tool call or `list_databases`.

**`src/cli.ts`** owns CLI parsing: the flags (`parseCli`), `USAGE` and `HELP`, `CliError` and `exitOnCliError`.

**`src/config.ts`** turns the CLI flags (`--database`, `--config`, `--idle-minutes`, `--access-mode`) and the optional JSON config file (zod, strict) into `DatabaseRegistry` options. `${VAR}` expansion happens there; an unset variable becomes a per-entry error, not a startup failure.

**`src/database-registry.ts`** is the `DatabaseRegistry`, which owns the access mode and builds every driver: tools call `registry.use(name, fn(sqlDriver))`, and `main` wires `deps.getSqlDriver` into it. It holds a lazily created `DbConnPool` per database, closed after `idleMinutes` with no call in flight, plus discovery of databases on config `servers` (`pg_database` query, include/exclude globs, prefix). Discovery re-runs on `list_databases` and on an unknown name.

**Access modes decide the driver.** `getSqlDriver()` (`src/sql/driver-factory.ts`) returns a plain `SqlDriver` in unrestricted mode and a `SafeSqlDriver` wrapping it in restricted mode. Every tool goes through it, so restricted mode constrains the health, explain and index tools too, not just `execute_sql`.

**Restricted mode** (`src/sql/safe-sql.ts`, `src/sql/allowlists.ts`) parses each statement with `libpg-query` and walks the JSON tree default-deny: statement types, node types, functions and extensions must all be on an allowlist. Accepted SQL is prefixed with `/* postgres-mcp */` and run in `BEGIN TRANSACTION READ ONLY` with a 30 s client-side timeout. The allowlists are copied verbatim from upstream; a node type or function missing from them is rejected by design, so adding SQL to an internal query can make it fail in restricted mode only.

**SQL building.** Internal queries use `{}` placeholders filled by `SafeSqlDriver.executeParamQuery` through `src/sql/literal.ts` (literal, identifier and array quoting), not `pg` bind parameters. Multi-statement strings go through the simple protocol and the last result is used.

**AST layer** (`src/sql/pg-ast.ts`). `libpg-query` returns `{ NodeType: {...} }` JSON. `AstNode` and `Visitor` reproduce pglast's traversal (visit method first, then default descent) because the index advisor's visitors in `src/sql/bind-params.ts` and `src/index/dta-calc.ts` were ported against that order. The WASM parser must be loaded (`loadParser()`) before `parseSqlSync` is used.

**Index advisor** (`src/index/`). `IndexTuningBase` (`index-opt-base.ts`) gathers the workload (from `pg_stat_statements` or given queries), costs configurations with `hypopg` hypothetical indexes and `EXPLAIN`, and produces the result; `DatabaseTuningAdvisor` (`dta-calc.ts`) supplies candidate generation and the greedy search; `presentation.ts` turns the result into the tool's JSON. Hypothetical indexes are named `postgres_mcp_idx_*`. The `method` tool parameter accepts only `"dta"`.

**Other tools.** `src/database-health/` has one calculator per health area, combined by `database-health.ts`. `src/explain/explain-plan.ts` and `src/artifacts.ts` build and diff explain plans. `src/top-queries/` reads `pg_stat_statements`, with column names that differ by server version (`src/sql/extension-utils.ts` caches the version per connection pool).

## Conventions specific to this repo

- **The tool surface is a contract.** Tool names, parameter names (snake_case), defaults, descriptions and CLI flags match upstream, and another project caches these schemas. `tests/unit/server-surface.test.ts` pins them. Do not rename or drop any of them without being asked. The required `database` parameter on every tool and the `list_databases` tool are a deliberate divergence from upstream and are pinned there too.
- **Faithful port.** Behaviour, messages and SQL text follow the Python original, including its defects. A defect inherited from upstream is recorded in `docs/TODO.md` (see Follow-ups below), not fixed in passing. `docs/TODO.md` also lists deferred structural refactors.
- **Keep "Differences from upstream" current.** With every change, check the "Differences from upstream" section of `README.md`: a change that makes this fork differ from upstream in a new way, or removes a difference, updates that section in the same change.
- **Output format.** Structured tool results are JSON; prose outputs keep upstream's wording. Number formatting that upstream did with Python format specs goes through `src/py-format.ts` and the helpers at the top of `src/index/index-opt-base.ts` (`naturalSize` is base 1000).
- **Number types from `pg`.** `int8` is parsed to `number` when safe and `bigint` otherwise; `numeric` stays a string and is converted with `Number()` where a calculation needs it.
- **Tests replace seams, not modules.** `server.ts` exports `deps` and `runners` objects so tests can swap the driver and transports; unit tests use `tests/support/fake-pool.ts` for `pg` and `tests/support/mcp-client.ts` to drive the server as a client.
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

Do not record trivial items (cosmetic wording, speculative polish). Do not group entries under section headings or priority tiers, do not use checkboxes, and do not add a separate type or category line to the body.

**Append only.** Add new entries at the end of the file, so it stays sorted oldest first. Never insert an entry above an existing one and never change an entry's date; its priority and type may be updated. When two branches both append, resolve the conflict by keeping both entries in date order.

## Lessons learned

When the user corrects a mistake you made — about this codebase, their preferences, or a general technical point — append one line to this section before continuing the task. Write it as a rule for future work, not as an account of what happened.

- Feature work in this repo ends in a pull request: ask before planning whether it goes to a PR rather than defaulting to leaving changes uncommitted, and put deferred review findings to the user as questions instead of listing them in the summary.
