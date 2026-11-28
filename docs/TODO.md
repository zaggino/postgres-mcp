# TODO

Follow-ups for this repository. Each entry is a heading of the form `## YYYY-MM-DD · <Critical|Major|Minor> · <Type> · <title>` followed by a short body: what happens, where in `src/`, and why it matters. An entry whose fix requires a breaking change starts its body with `_BREAKING CHANGE REQUIRED_`. The file is append-only, oldest entries first; delete an entry once it is resolved.

## 2026-11-26 · Minor · Bug · Shutdown does not cover SIGHUP or a closed stdout

`src/main.ts` installs handlers for SIGTERM and SIGINT and reacts to stdin closing, but not to SIGHUP. Whether a reply written after the client closed stdout (EPIPE) ends the process without closing the pool has not been checked; `zaggino/lazy-pg-mcp` records that failure for itself. Handle SIGHUP, and route a stdout `error` through `shutdown()` if the check shows the problem.

## 2026-11-26 · Minor · Docs · `AGENTS.md` lacks two rules that `zaggino/lazy-pg-mcp` has

Its agent instructions require the file itself to be updated in the same change that makes a statement in it wrong, and a lesson to be recorded for any non-obvious pitfall, not only after a correction from the user. Its tests follow "one test file per behaviour". Decide which of these to adopt in `AGENTS.md`.

## 2026-11-26 · Minor · Bug · Table-size estimate always falls back to 10 MB

`getTableSize` in `src/index/index-opt-base.ts` runs `pg_total_relation_size(quote_ident({}))`; the placeholder is expanded to a string literal and `quote_ident` returns text, which `pg_total_relation_size` does not accept. The query always fails and `estimateTableSize` supplies the fallback, so index-size limits use a wrong table size.

## 2026-11-26 · Minor · Bug · Replication health check returns nothing in restricted mode

`ReplicationCalc` in `src/database-health/replication-calc.ts` uses WAL functions such as `pg_last_wal_receive_lsn()` that are not in the function allowlist in `src/sql/allowlists.ts`. In restricted mode the lag query is rejected and the check reports nothing. `ReplicationCalc.#tryQuery` treats that `QueryValidationError` as "not available"; once the allowlist accepts the lag query, drop the `QueryValidationError` case there, so a later allowlist regression in internal SQL is reported instead of hidden.

## 2026-11-26 · Minor · Bug · Bind-parameter collector has a dead `AEXPR_OP` branch and may miss `IN (SELECT ...)`

The `A_Expr` visitor in `src/sql/bind-params.ts` ends with a branch for `kind === "AEXPR_OP"` with a `SelectStmt` right-hand side, ported from upstream's `kind == 0` whose comment meant `IN`. The block just above already visits any `SelectStmt` right-hand side in its own scope, so the branch only repeats that visit. `libpg-query` parses `x IN (SELECT ...)` as a `SubLink` (`ANY_SUBLINK`), not an `A_Expr`, and `x IN (1, 2)` as `AEXPR_IN` with a `List`, so neither form reaches the branch. Delete it, and check whether the columns of an `IN (SELECT ...)` subquery are collected in the subquery's scope.

## 2026-11-26 · Minor · Bug · Workload SQL is lowercased wholesale

`src/index/index-opt-base.ts` (workload loop in the query analysis, `rawQuery.trim().toLowerCase()`) lowercases the whole query before binding parameters, including string literals and quoted identifiers. This can change the meaning of the query being analysed.

## 2026-11-26 · Minor · Bug · A zero-column SELECT is reported as "no result set"

`executeResultSet` in `src/sql/sql-driver.ts` reports both a result with no columns and a statement without a result set as `columns: []`, so `execute_sql` answers "No results" for `SELECT FROM t`. Telling them apart needs the statement's command tag, which `QueryResultLike` does not carry yet.

## 2026-11-26 · Minor · Bug · Duplicate column names collapse in a row object

Rows (`Row` in `src/sql/sql-driver.ts`) are `Record<string, unknown>`, so `SELECT 1 AS a, 2 AS a` returns one `a` value: later columns overwrite earlier ones. `executeResultSet` returns the column names, including duplicates, so `execute_sql` could fetch rows in array mode and keep every column; how duplicates should appear in its JSON output is undecided.

## 2026-11-26 · Minor · Bug · Restricted mode rejects `VACUUM <table>` and `ANALYZE <table>`

`VacuumRelation` is not in the node allowlist in `src/sql/allowlists.ts`, so `SafeSqlDriver` in `src/sql/safe-sql.ts` accepts only the bare forms.

## 2026-11-26 · Minor · Bug · Empty or comment-only query passes validation

`SafeSqlDriver` in `src/sql/safe-sql.ts` finds no statements to reject in an empty or comment-only query and sends it to the database.

## 2026-11-26 · Minor · Refactor · Node allowlist contains planner-only node types

The node allowlist in `src/sql/allowlists.ts` includes types that appear only in planned or analysed trees, never in a raw parse tree from `libpg-query`. They are dead entries and obscure what is actually allowed.

## 2026-11-26 · Minor · Bug · Statements that cannot run in a transaction fail in unrestricted mode

`executeWithClient` in `src/sql/sql-driver.ts` wraps every query in `BEGIN`/`COMMIT`, so `CREATE INDEX CONCURRENTLY`, `VACUUM` and similar fail.

## 2026-11-26 · Minor · Bug · Column collection stops after a nested SELECT

`ColumnCollector` in `src/sql/bind-params.ts` resets its `inside_select` state when it leaves a nested SELECT, so columns after a subquery in the same scope are not collected.

## 2026-11-26 · Minor · Bug · Derived-table aliases are treated as table names

`TableAliasVisitor` in `src/sql/bind-params.ts` records a subquery alias as a table. The statistics lookup then queries `pg_stats` for a table that does not exist, and the fallback key `most_common_vals` is never selected by the stats query.

## 2026-11-26 · Minor · Bug · Parameter replacement works on the original query and mishandles `$10`

`SqlBindParams.replaceParameters` in `src/sql/bind-params.ts` runs column extraction and BETWEEN matching on the original query, and replacing `$1` also hits the prefix of `$10`. Queries with ten or more parameters get wrong bindings.

## 2026-11-26 · Minor · Bug · Unqualified columns are assigned to the first table in scope

`src/sql/bind-params.ts` attributes every unqualified column to the first table in the query. In joins this looks up statistics for the wrong table.

## 2026-11-26 · Minor · Bug · Column names are embedded unescaped in regular expressions

`identifyParameterColumn` and the rewrite helpers in `src/sql/bind-params.ts` build regexes from raw column names. Names with regex metacharacters mis-match, and `identifyParameterColumn` swallows the resulting invalid-regex error, so the failure goes unreported.

## 2026-11-26 · Minor · Bug · Rewrite regexes use ASCII-only `\w`

Regexes in `src/sql/bind-params.ts` use `\w`, which in JavaScript matches ASCII only, so non-ASCII column names are truncated. Use `\p{L}` with the `u` flag.

## 2026-11-26 · Minor · Bug · `pg_stats` integers above 2^53 lose precision

Statistics values in `src/sql/bind-params.ts` pass through `number`, so very large `bigint` histogram bounds are rounded before being bound into the query.

## 2026-11-26 · Minor · Bug · Empty hypothetical-index plan path needs a tracer

`explainWithHypotheticalIndexes` in `src/explain/explain-plan.ts` fails with an error when the hypothetical index list is empty and no DTA tracer is supplied, instead of returning the infinite-cost fallback plan.

## 2026-11-26 · Minor · Bug · Infinite-cost fallback plan cannot become an artifact

The fallback plan built in `src/explain/explain-plan.ts` has no `Node Type`, so `ExplainPlanArtifact` in `src/artifacts.ts` cannot be created from it.

## 2026-11-26 · Minor · Bug · Error message prefix is missing a word

`src/top-queries/top-queries-calc.ts` returns "Error resource-intensive queries:" where "Error getting resource-intensive queries:" is meant.

## 2026-11-26 · Minor · Bug · Index-health column split breaks on expression indexes

`src/database-health/index-health-calc.ts` splits column lists on `", "`, so an expression index containing a comma is split into bogus columns.

## 2026-11-26 · Minor · Bug · Vacuum health default `maxValue` looks like a typo

`src/database-health/vacuum-health-calc.ts` defaults `maxValue` to 2146483648, probably meant to be 2147483647 (2^31 - 1).

## 2026-11-26 · Minor · Bug · Index recommendations drop the long-text warning

`src/index/presentation.ts` rebuilds recommendations as fresh objects without `potentialProblematicReason` or the size, so the long-text warning set in `src/index/dta-calc.ts` never reaches the output.

## 2026-11-26 · Minor · Refactor · Seed-column handling in the advisor is partly dead

`seedColumnsCount` and `minColumnUsage` in `src/index/dta-calc.ts` are only partly used: `generateRecommendations` starts the greedy search from the empty seed alone, so no seed pass uses them. Either implement the seed pass or remove the options.

## 2026-11-26 · Minor · Bug · Condition column collector ignores nested joins

`ConditionColumnCollector` in `src/index/dta-calc.ts` processes the quals of top-level `JoinExpr` items only, so index candidates from nested joins are missed.

## 2026-11-26 · Minor · Bug · Time limit is not hit immediately without `analyzeWorkload`

`analysisStartTime` in `src/index/dta-calc.ts` defaults to 0 and is compared with `performance.now()`. Calling `enumerateGreedy` without `analyzeWorkload` therefore does not stop at the time limit at once, as it should.

## 2026-11-26 · Minor · Bug · `getPostgresVersion` rejects pre-release versions

`getPostgresVersion` in `src/sql/extension-utils.ts` cannot parse server versions such as `17beta1`, so the version lookup fails on a pre-release server.

## 2026-11-26 · Minor · Security · Publishing has no approval gate

The `main` environment that `.github/workflows/release-please.yml` publishes from only restricts deployments to the `main` branch, so merging a release PR (or dispatching the workflow with `publish`) publishes to npm without a second person's approval. Required reviewers cannot simply be added to `main`: the `release-please` job uses it too and would then wait for approval on every push. Move the `publish` job to its own environment (and the npm trusted publisher with it) with required reviewers, "Prevent self-review" on and admin bypass off, or the person who triggers a run can approve it alone. (Creating `v*` tags, which the publish guard trusts, is already limited to admins by the "release tags: creation" ruleset.)

## 2026-11-26 · Minor · Refactor · `ALLOWED_EXTENSIONS` is unreachable in restricted mode

`CREATE EXTENSION` cannot run in a read-only transaction, so the allowlist in `src/sql/allowlists.ts` never takes effect. Trim it or document why it stays.

## 2026-11-26 · Minor · Tests · Index advisor integration tests can mask a regression

`tests/integration/dta-calc.test.ts` skips when no recommendation is produced and retries twice, so a regression that stops recommendations can pass.

## 2026-11-26 · Major · Refactor · `ConditionColumnCollector` inherits from a class it does not use

`ConditionColumnCollector` in `src/index/dta-calc.ts` extends `ColumnCollector` (`src/sql/bind-params.ts`) but overrides or disables all of its behaviour and redeclares its state under new names. Make it extend `Visitor` directly, move it to its own file, and share the scope and alias helpers between the two collectors.

## 2026-11-26 · Major · Refactor · AST struct-shape table lives in the security allowlist file

`STRUCT_FIELD_TYPES` in `src/sql/allowlists.ts` describes parse-tree shape, not policy, and `src/sql/pg-ast.ts` imports it from there. Move it next to the parser, add `IndexStmt.relation`, and expose one value classifier that both the visitor traversal (`pg-ast.ts`) and the validator (`src/sql/safe-sql.ts`) use, so the two walkers cannot disagree.

## 2026-11-26 · Minor · Tooling · `promise-function-async` and `strict-boolean-expressions` are switched off

`oxlint.config.ts` switches off `typescript/promise-function-async` (50 findings) and `typescript/strict-boolean-expressions` (40) because some of their fixes change behaviour.

Of the `promise-function-async` findings, 24 are in `tests/`, and most of the rest are one-line delegations or the tool callbacks in `src/server.ts`, which can be marked `async` mechanically. About ten need judgement, because marking them `async` turns a synchronous throw into a rejection: `SafeSqlDriver.executeParamQuery` (`src/sql/safe-sql.ts`), `poolConnect` (`src/sql/sql-driver.ts`), and the methods with default parameters in `src/index/presentation.ts` and `src/database-health/buffer-health-calc.ts`.

Replacing a truthiness check on a nullable string or boolean changes which values pass, for example `""`. Triage these five first, because they are not that case:

- `!this.timeout` in `src/sql/safe-sql.ts`, where `0` means no timeout.
- `any` values in conditionals in `src/database-health/index-health-calc.ts`, `src/index/dta-calc.ts`, `src/index/index-opt-base.ts` and `src/tools/objects.ts`.

Go through the findings, keep the current behaviour unless a change is intended, and switch the rules back on.

## 2026-11-26 · Major · Infra · The first npm publish has to be done by hand

`.github/workflows/release-please.yml` publishes through npm trusted publishing, which is configured on an existing package, and `@zaggino/postgres-mcp` has never been published. The workflow's publish of the first release, 1.0.0, will fail; publish 1.0.0 by hand from the `v1.0.0` tag, then configure the trusted publisher (repository `zaggino/postgres-mcp`, workflow `release-please.yml`, environment `main`) so later releases publish themselves.

## 2026-11-26 · Minor · Feature · Server discovery needs a URL-form server URI

Discovery of the databases on a config `servers` entry builds each database URI by replacing the path of the server URL (`#discoverSource` in `src/database-registry.ts`), so the server `uri` must be a `postgres://` or `postgresql://` URL. Key/value DSNs and `dbname=` query parameters are not supported and are reported as an error for that server. Support them by rewriting the `dbname` of a DSN or query string.

## 2026-11-26 · Minor · Feature · Discovered databases with reserved characters in their names cannot be used

`pg-connection-string` decodes the URL path with `decodeURI`, which leaves `%2F`, `%3F`, `%23` and the other reserved escapes in place, so `databaseUri` in `src/database-registry.ts` reports a discovered database named like `a/b` as an error instead of connecting (it would otherwise reach a database literally named `a%2Fb`). Support such names by passing the database name through the pool config instead of the URL.

## 2026-11-26 · Minor · Performance · Unknown database names rerun discovery and open pools have no cap

`DatabaseRegistry.use` in `src/database-registry.ts` reruns discovery on every server for each unknown `database` value, so a model looping over wrong names queries every server each time. Each database used gets its own pool (up to 5 connections) that stays open for `idleMinutes`, with no limit on how many are open at once, so a server with many databases can reach `max_connections`. Add a short negative cache for unknown names, and a cap on open pools.

## 2026-11-26 · Minor · Refactor · Server URIs are validated in two places

`configServer` in `src/config.ts` checks a server `uri` only when it has no `${VAR}`, so `#discoverSource` in `src/database-registry.ts` checks it again after expansion on every discovery run, and `config.ts` imports `isPostgresUrl` and `NOT_A_POSTGRES_URL` from the registry for that. Validate once in `config.ts` after expansion (a fatal `CliError` for a literal URI, a `{ error }` spec for an expanded one), seed `SourceState.error` and the source pool in the registry constructor, and drop the re-check, the lazy pool creation inside the `try` and the dead `'error' in source.uri` ternary in `list()`.

## 2026-11-26 · Minor · Refactor · `SqlExecutor.pool` exists only to key the version cache

`getPostgresVersion` in `src/sql/extension-utils.ts` keys its cache by `sqlDriver.pool ?? sqlDriver`, because `DatabaseRegistry.use` builds a new driver on every call; that put an optional `pool` member on `SqlExecutor` with pass-through getters on `SafeSqlDriver` and `SqlDriver`, and the key of an `engineUrl` driver changes between the read and the write. Each call's driver now carries that call's abort signal, so one driver per connection no longer works. Key the cache by the `DbConnPool` (or `IdlePool`) the driver was built on, and remove `pool` from the interface.

## 2026-11-26 · Minor · Refactor · Pool retirement is tracked in two places

`IdlePool` in `src/database-registry.ts` has `#retired` and `isFinished`, and the registry keeps its own `#retired` set that `#retireStalePools` sweeps only on the next discovery. Let `retire()` return a promise that settles once the pool has drained and closed, and remove the pool from the set when it settles; `isFinished` and the sweep go.

## 2026-11-26 · Minor · Tests · Gaps in the multi-database tests

Untested so far: `--idle-minutes` and config `idleMinutes` above 35791 are rejected; `list_databases` shows `open` with a counting-down `idle_seconds_left` after a successful call; a server whose `${VAR}` is unset shows the error in `servers[].error` and its databases are unknown; an invalid `--database` name, a duplicate name, an unreadable config file. Add one case each to `tests/unit/config.test.ts` and `tests/unit/database-registry.test.ts`.

## 2026-11-26 · Minor · Refactor · Session and pool idle timers are two implementations

`SessionStore` in `src/transports/sessions.ts` and `IdlePool` in `src/database-registry.ts` each hold a per-entry `setTimeout`, with the in-flight rule and `unref` written twice. A shared `IdleTimer` (start, pause while busy, clear) would serve both, and would own `MAX_IDLE_MINUTES`, the `setTimeout` limit that bounds both timers and is defined next to `IdlePool` for now.

## 2026-11-27 · Minor · Refactor · Resolve each discovery server once instead of per discovery and per listing

`src/database-registry.ts` parses a server's URI in `isPostgresUrl`, `serverUriWithDefaults` and `serverLabel` on every discovery and every `list_databases`, and `#discoverSource` and `list()` each branch on `'uri' in source.uri`. The source URI cannot change after construction, so resolve it once when the registry is built into `{ uri, label } | { error }` (protocol check, port and database defaults, label) and keep it on `SourceState`. That removes the repeated parsing and the branches, and the label is then the host of the connect URI by construction. Decide whether a non-postgres URI keeps its host label next to its error.

## 2026-11-27 · Minor · Tests · An explicit database in a server URI is not tested to survive the defaults

The port is covered: `tests/unit/list-databases.test.ts` labels a `:5433` server and `tests/unit/database-registry.test.ts` a `?port=6543` one. The database is not: every discovery test either leaves it out or uses `/postgres`, which equals the default, so a bug in `serverUriWithDefaults` that always replaced the database would pass. Add a case with an explicit non-default database (for example `postgresql://u:p@h:6543/other`: discovery connects to `other`) and one for the trailing-slash form `postgresql://u:p@h:6543/` (database becomes `postgres`, port kept).

## 2026-11-27 · Minor · Performance · `list_databases` output repeats the same fields for every database

_BREAKING CHANGE REQUIRED_

Each entry in the `list_databases` result (`DatabaseRegistry.list()` in `src/database-registry.ts`) carries `source`, `state` and `idle_seconds_left`, mostly as `"server"`, `"closed"` and `null`. With 30 discovered databases one call costs about 1.5k tokens of an agent's context, most of it repetition. Group the databases under their source and leave out null and default fields (for example list closed databases by name only), which should cut the output by more than half. The tests in `tests/unit/list-databases.test.ts` and the `list()` tests in `tests/unit/database-registry.test.ts` need updating.

## 2026-11-27 · Major · Bug · Object listings read `information_schema`, which hides objects the role cannot access

`list_schemas`, `list_objects` and `get_object_details` in `src/tools/objects.ts` query `information_schema.schemata`, `.tables`, `.sequences`, `.columns` and `.table_constraints`. Those views show only objects the current role owns or holds a privilege on, so a role without grants gets `[]` for a schema that has tables, which looks like an empty schema rather than missing permissions. Seen with a read-only role on a database with ~150 tables: `list_objects` style queries returned nothing while `pg_tables` listed all of them. Fix by reading `pg_catalog` (`pg_namespace`, `pg_class`, `pg_attribute`, `pg_constraint`) and reporting what the role can do with each object, using the privilege check for its kind (`has_table_privilege` for tables and views, `has_sequence_privilege` for sequences). Visibility also differs by view: a role with SELECT on a table sees its columns, but `information_schema.table_constraints` shows constraints only to the table's owner or a role with a privilege other than SELECT, so `get_object_details` can show a readable table without its constraints. Check every query stays within the restricted-mode allowlists.

## 2026-11-27 · Minor · Bug · Shutdown waits without limit for running statements

`shutdown()` in `src/main.ts` awaits `registry.closeAll()`, which ends every pool with `pool.end()`. node-postgres resolves `pool.end()` only once every client is released, including clients still running a statement, so shutdown lasts as long as the longest running call: up to the statement timeout (30 s by default in restricted mode, none by default in unrestricted mode). On stdio this starts when the client closes stdin. A client that does not kill the server leaves it running until the statement finishes. A client that does kill it after a short grace period leaves the statement running in postgres, because postgres does not notice the closed socket while a statement executes. Some clients wait only about half a second between closing stdin and SIGKILL. Bound `closeAll` (a few seconds), then cancel the statements still running and destroy their clients. The cancel path exists: aborting the `signal` a `SqlDriver` was built with (`src/sql/sql-driver.ts`) sends a CancelRequest for its running statement, so shutdown can abort the signals of the calls in flight.

## 2026-11-27 · Minor · Feature · Health, top-queries and index tools report failures without `isError`

_BREAKING CHANGE REQUIRED_

`formatError` in `src/tools/result.ts` sets `isError` on an `Error:` result whose SQL got no answer from Postgres, but `analyze_db_health`, `get_top_queries`, `analyze_query_indexes` and `analyze_workload_indexes` catch their failures deep inside and return them as ordinary output: health text (`src/database-health/database-health.ts`), `Error getting slow queries: ...` text (`src/top-queries/top-queries-calc.ts`) and `{"error": ...}` JSON (`src/index/presentation.ts`). A connection failure or restricted-mode timeout on these tools is therefore not flagged, and the server instructions only tell agents that these tools report failures in their output. Let those paths return the error (or a result carrying it) to the tool handler so it can go through `formatError`, then drop the clause from `serverInstructions` (`src/server-instructions.ts`) and the note from README's "Differences from upstream".

## 2026-11-27 · Minor · Security · Query cancel requests are sent without TLS

`sendCancelRequest` in `src/sql/sql-driver.ts` sends the CancelRequest (backend pid and secret key) over plain TCP even when the connection uses TLS, as libpq and pg do; an observer on the network path can then cancel that connection's statements. Postgres 18 / protocol 3.2 allows cancel over TLS; send it over TLS when the connection uses it.

## 2026-11-27 · Minor · Bug · list_databases and discovery ignore cancellation

`list_databases` in `src/server.ts` gets no call signal, and discovery triggered by an unknown name (`DatabaseRegistry.use`) runs before the call's driver exists, so cancelling either call leaves the discovery query running (bounded by the statement timeout).

## 2026-11-27 · Minor · Tests · Gaps in the cancellation and statement-timeout tests

Untested: `cancel_query` in one session cannot list or cancel another session's calls; an explicit `statementTimeoutSeconds: 0` in restricted mode sends no `SET statement_timeout`; `--statement-timeout` reaches the registry and the server instructions through `main` (the config tests stop at `resolveConfig`).

## 2026-11-27 · Minor · Refactor · Split `src/sql/sql-driver.ts`

`src/sql/sql-driver.ts` is about 670 lines and holds six concerns: password masking (`obfuscatePassword`, `maskError`), the error classes and their classifier, the pg adapter with the CancelRequest wire protocol (`pgPool`, `sendCancelRequest`, `poolConfig`, `customTypes`, the pool constants), the per-call transaction runner (`executeWithClient`), `DbConnPool` and `SqlDriver`. `src/sql/connection-queue.ts` also imports its types from it while it imports `queuedPool` back. Move `PoolLike`/`ClientLike` and the pg adapter into `src/sql/pg-pool.ts` and the masking into its own module.

## 2026-11-27 · Minor · Refactor · Each tool is split between `src/server.ts` and `src/tools/`

`createServer` in `src/server.ts` holds each database tool's name, description, zod schema and description constants, while its body lives in `src/tools/objects.ts` or `src/tools/analysis.ts`; eight lambdas map the snake_case arguments to positional parameters, so adding a parameter touches two files and the adapter. Let the tools modules export whole tool definitions (name, description, annotations, `errorLog`, `inputSchema`, `body(sqlDriver, args)`, typed through a small `defineDatabaseTool` helper; `execute_sql`'s as a function of the access mode) and have `createServer` loop over them, leaving it the register helper, `list_databases` and `cancel_query`. Regroup the tools by what they do while at it: `analysis.ts` also holds `execute_sql` and `explain_query`.

## 2026-11-27 · Minor · Refactor · `offersCancelQuery` lives in the instructions module

`offersCancelQuery` in `src/server-instructions.ts` decides whether `createServer` (`src/server.ts`) registers `cancel_query`, and `server.ts` imports it back from the module that only renders the instructions text. Let `createServer` (or `DatabaseRegistry`, which owns the access mode) make that decision and pass it to `serverInstructions`, so the instructions module only renders text.

## 2026-11-27 · Minor · Tests · Shutdown state is module-level

`src/main.ts` keeps `shutdownInProgress` and `removeSignalHandlers` as module variables, so `shutdown` refuses to run twice per module load and `tests/unit/shutdown.test.ts` has to re-import `main.ts` after `vi.resetModules()` for every test. Hold that state in an object that `main` creates (and `shutdown` receives), so tests can run it without reloading the module.

## 2026-11-27 · Minor · Refactor · Some stderr lines have no level prefix

About 30 `logLine` calls in `src/` (the SQL driver, index advisor, bind parameters, explain, health, top queries, extension utilities, the registry's idle-pool close and the fatal error in `src/index.ts`) write unprefixed lines, while the rest use `log(level, ...)` with an `INFO:`/`WARNING:`/`ERROR:` prefix. Stderr mixes both styles and the severity of the unprefixed lines is lost. Move them to `log(level, ...)` with the right level. The CLI usage error in `src/cli.ts` stays unprefixed; if it is the only caller left, keep `logLine` for it alone.

## 2026-11-27 · Minor · Bug · Raw `toFixed` calls bypass `formatFixed`

`src/artifacts.ts` (plan costs and times) and the health calculators (`buffer-health-calc.ts`, `index-health-calc.ts`, `replication-calc.ts`, `sequence-health-calc.ts` in `src/database-health/`) format numbers with `.toFixed(n)` instead of `formatFixed` from `src/py-format.ts`. A non-finite value then prints `Infinity` or `NaN`, while the advisor output prints `inf` or `nan`. Route them through one formatter so all output agrees.

## 2026-11-27 · Minor · Bug · Two bind-parameter log lines print `Error: ` before the message

`src/sql/bind-params.ts` logs "Error extracting table aliases" and "Error getting column statistics" with `String(error)`, which prints the error class name before the message, while the rest of the code uses `errorMessage` from `src/errors.ts`. Switch them to `errorMessage`; that changes stderr output.

## 2026-11-27 · Minor · Refactor · Replace the Python-imitating helpers

Several helpers exist only to reproduce Python's output or semantics: `pyTypeName` in `src/py-format.ts` (`<class 'dict'>` in the EXPLAIN result checks and traces in `src/explain/explain-plan.ts`), `pyFloatStr` (Python float text in the advisor traces in `src/index/dta-calc.ts`), `pyLog` and `pyDivide` in `src/index/dta-calc.ts`, and `pyStr` in `src/sql/bind-params.ts`. Replace `pyTypeName` with plain messages such as "expected a JSON array from EXPLAIN", use `String` in the traces, and replace the arithmetic helpers with plain JavaScript where the Python error cases cannot occur. `formatFixed` and `formatPercent` stay. The statistics literals in `bind-params.ts` are a separate entry.

## 2026-11-27 · Minor · Docs · Code comments cite upstream as the reason for behaviour

About 34 lines in `src/` and 6 in `tests/` that mention upstream or Python, and two reasons in `oxlint.config.ts`, give upstream as the reason for a behaviour: inline lint-disable reasons ("as upstream does", "mirrors upstream"), doc comments such as the one on `logLine` in `src/log.ts`, and test names such as "lists the eleven tools in upstream order". Since upstream is no longer a specification (`AGENTS.md`, "Upstream is a reference"), they read as constraints that no longer exist. Sweep them in one change: reword each one to give the real reason, or turn it into a TODO entry where the behaviour itself should change.

## 2026-11-28 · Minor · Bug · Statistics values are written into SQL as Python float text

`SqlBindParams` in `src/sql/bind-params.ts` fills query parameters with values from `pg_stats`, writing floats through `pyFloatStr` (`1.0`, `1e-05`) and integers as plain text, with no cast. The literal's type then depends on its spelling, which can pick a different operator or plan from the one the real parameter type would. Write each value with an explicit cast to its column's type, and drop the `pyFloatStr` call.

## 2026-11-28 · Minor · Feature · `naturalSize` uses decimal units

`naturalSize` in `src/py-format.ts` reproduces `humanize.naturalsize` (base 1000, `kB`), and its output reaches users through the index advisor results (`src/index/presentation.ts`) and traces. `pg_size_pretty` and `psql` use base 1024, so the same size reads differently. Decide whether to switch to base 1024; it changes tool output, so mention it in the release notes.

## 2026-11-28 · Minor · Feature · Index advisor output is untyped and formats numbers as text

_BREAKING CHANGE REQUIRED_

`analyze_query_indexes` and `analyze_workload_indexes` build their result in `src/index/presentation.ts` as `Record<string, unknown>`, in the shape the Python server printed:

- `recommendations` is an array, or the sentence `No index recommendations found.` when there are none.
- Costs and improvement multiples are strings made by `formatFixed`. A cost that is infinite prints `"inf"`, and `query_impact` puts `"∞"` in `improvement_multiple` unless both costs are above zero.
- `total_size_bytes` and `index_estimated_size` hold `naturalSize` text such as `1.0 kB`, not a byte count.

No tool declares an `outputSchema` or returns `structuredContent`, so a client cannot validate a result. Give the two tools a zod output schema with one type per field: numbers as numbers, `null` where a cost or multiple is not finite, the unit in the key name (`size_bytes`), and an empty array for no recommendations. Then declare it as `outputSchema` and return `structuredContent` next to the text.

Do this after "Health, top-queries and index tools report failures without `isError`". The MCP SDK rejects a result of a tool with an `outputSchema` when it has neither `isError` nor matching `structuredContent`, and today the advisor returns its failures as ordinary `{ "error": ... }` output. Keep the schema with the tool definition; "Each tool is split between `src/server.ts` and `src/tools/`" decides where that is.

Changing a field's type breaks callers that read the current shape, so commit it as `feat!`, preferably before 1.0.0, and update `tests/unit/server-surface.test.ts` and README's "Differences from upstream". It removes the last uses of `naturalSize`, which settles "`naturalSize` uses decimal units". The other tools cannot simply follow: `structuredContent` must be an object, and `execute_sql` and the listing tools return an array or plain text.

## 2026-11-28 · Minor · Refactor · Tuples and forwarding classes in the advisor and explain code

Shapes carried over from Python that TypeScript would write as named objects and interfaces:

- `QueryWeight` and `IndexConfiguration` (`src/index/index-opt-base.ts`) are tuples, labelled but read by position.
- Three functions return a tuple: `checkPostgresVersionRequirement` and `checkHypopgInstallationStatus` (`src/sql/extension-utils.ts`) return `[boolean, string]`, and `replaceQueryParametersIfNeeded` (`src/explain/explain-plan.ts`) returns `[query, useGenericPlan]`. The only caller of `checkPostgresVersionRequirement` discards the message.
- `IndexRecommendation` is five getters forwarding to its `IndexDefinition` plus two mutable fields. `IndexRecommendationAnalysis` copies an `Init` interface field by field into a class and adds five more forwarding getters and `toIndex()`.

Replace the tuples with `{ query, stmt, weight }`, `{ indexes, cost }` and `{ query, useGenericPlan }`, and return a boolean for the version requirement. Let `checkHypopgInstallationStatus` return the extension's status and let its two callers render the message, which also removes its `messageType` parameter. Turn the two recommendation classes into readonly interfaces with the improvement multiples as functions. No output changes.

## 2026-11-28 · Minor · Bug · Advisor sets compare `IndexRecommendation` objects by identity

`generateRecommendations` in `src/index/dta-calc.ts` keeps candidates and chosen indexes in `Set<IndexRecommendation>`. A JavaScript `Set` compares objects by identity, where the Python original compared them by table, columns and method. `candidateIndexes.delete(idx)` therefore never removes a seed index, because the candidates are new objects, and two candidates for the same index would both stay in the set. Neither is reachable today: the only seed is the empty one (see "Seed-column handling in the advisor is partly dead"), and no path is known to produce two equal candidates. Key the sets by `IndexDefinition.key`, as `configurationKey` (`src/index/index-opt-base.ts`) does.

## 2026-11-28 · Minor · Bug · The index advisor never uses a column's most common value as a range bound

`boundValues` in `src/sql/bind-params.ts` picks a range bound from the most common values and their frequencies, then from the histogram, and had a last fallback to the first most common value. That fallback read `most_common_vals`, which `STATS_QUERY` selects as `common_vals`, so it never fired and was dropped when the statistics got a typed interface. When the frequencies are missing or do not match the values, the advisor falls back to a type default although a real value is available. Restore the fallback on the typed `commonVals` field, with a test, and check that the advisor results for the integration workload still make sense.

## 2026-11-28 · Minor · Refactor · `SqlExecutor` carries parameters only `SafeSqlDriver` uses

`executeResultSet(query, params?, forceReadonly?)` is the public seam, but only `SafeSqlDriver` passes `params` and `forceReadonly` to its inner driver, and `SafeSqlDriver` ignores the `forceReadonly` it receives. Type `SafeSqlDriver`'s inner driver as the concrete driver contract and shrink the public seam to `executeResultSet(query)`. Also move the static `SafeSqlDriver.executeParamQuery`, which works on any executor, to a free function next to `queryRows`.

## 2026-11-28 · Minor · Bug · One unreadable sequence fails the whole sequence check

The per-sequence `SELECT … FROM <sequence>` in `src/database-health/sequence-health-calc.ts` errors with "permission denied" before `has_sequence_privilege` is consulted, so a role that cannot read one sequence gets no sequence report. Skip, or report, an unreadable sequence instead.

## 2026-11-28 · Minor · Refactor · Replication health keeps branches for servers before PostgreSQL 10

`ReplicationCalc` (`src/database-health/replication-calc.ts`) reads `server_version_num` itself and keeps `pg_last_xlog_*` and pre-9.4 slot branches. Decide the oldest supported server, delete the dead branches, and use `getPostgresVersion` (`src/sql/extension-utils.ts`) if a version check remains.

## 2026-11-28 · Minor · Bug · Arrays of user-defined types and some geometric types come back as one string

_BREAKING CHANGE REQUIRED_

`pg` has parsers only for some built-in array types, and `customTypes` in `src/sql/type-parsers.ts` adds a few more, so an array of an enum, domain or composite type, and a `box[]`, `lseg[]`, `line[]`, `path[]` or `polygon[]`, reaches `execute_sql` output as the Postgres array literal in one string: `ARRAY['a','b']::my_enum[]` returns `"{a,b}"`, while a `text[]` returns `["a","b"]`. User-defined OIDs differ per database, so a parser has to be chosen at query time, for example from the field's `typcategory` or by `typelem` lookup per pool; `box[]` uses `;` as its delimiter, which the `text[]` parser does not. `tests/integration/value-types.test.ts` pins the enum-array form.

## 2026-11-28 · Minor · Security · Hypothetical index definitions are built from unquoted input

`IndexDefinition.definition` in `src/sql/index-definition.ts` interpolates `table`, `columns` and `using` into `CREATE INDEX ... ON <table> USING <using> (<columns>)` without quoting, and `explain_query` takes all three from the client (only typed as non-empty strings by the schema in `src/server.ts`). The text reaches Postgres as a quoted literal argument of `hypopg_create_index`, which builds a hypothetical index rather than running it, so no injection path is known; but restricted mode's allowlist walk sees only that literal, not the index expression inside it, and the values also feed the generated `postgres_mcp_idx_*` name. Harden by checking `table` as a (possibly schema-qualified) identifier, limiting `using` to the index methods (`btree`, `hash`, `gist`, `spgist`, `gin`, `brin`), and checking that each column parses as an index element.
