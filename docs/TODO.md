# TODO

Follow-ups for this repository. Each entry is a heading of the form `## YYYY-MM-DD · <Critical|Major|Minor> · <Type> · <title>` followed by a short body: what happens, where in `src/`, and why it matters. The file is append-only, oldest entries first; delete an entry once it is resolved.

## 2026-11-26 · Major · Feature · A cancelled or long-running tool call cannot be stopped

The server ignores the client's `notifications/cancelled`, and unrestricted mode has no call timeout at all, so a statement runs in postgres to its end. `zaggino/lazy-pg-mcp` works around this from outside by removing the backend and terminating its sessions. Do it in the server: cancel the running statement when the tool call's abort signal fires, and add a configurable call timeout that applies in both access modes. The restricted-mode side (the 30 s timeout that leaves the statement running) is the entry "Restricted-mode timeout is client-side only"; fix the two together.

## 2026-11-26 · Minor · Feature · Server instructions give no guidance beyond the `database` argument

`serverInstructions` in `src/server.ts` only tells the model that every tool except `list_databases` needs a `database` argument and which databases exist, so a model has no other guidance on the server's behaviour. Add the following, keeping each clause short (the text costs tokens in every session, about 35 now):

- **Server errors vs SQL errors.** The instructions should say a result starting with `Error:` comes from the query, not from the server, but that does not hold yet: `formatError` prefixes every failure with `Error:`, the server's own (unknown database, unset `${VAR}`, restricted-mode rejection, connection failure) as well as SQL errors. Make server-raised failures distinguishable first (for example `isError: true` or a distinct prefix; check upstream's output and the pinned surface), then state the rule.
- **How to diagnose failures.** Relay the error text to the user first, then check the likely configuration causes: an unset `${VAR}` in the config, wrong credentials, an unreachable host, a role without grants (which also makes the `information_schema` listings come back empty; see "Object listings read `information_schema`, which hides objects the role cannot access").
- **Suggest opening issues.** If a failure still looks like a server bug, or a change to the server would make working with the databases easier (a missing tool or argument, an unclear description or error message), tell the user and suggest an issue at https://github.com/zaggino/postgres-mcp/issues (`bugs.url` in `package.json`).
- **Timeouts and cancellation.** State the access mode in effect and its limits: restricted mode abandons a call after 30 s but the statement keeps running in postgres, unrestricted mode has no timeout, and cancelling a call does not stop its SQL. Update the clause when "A cancelled or long-running tool call cannot be stopped" and "Restricted-mode timeout is client-side only" are fixed.

## 2026-11-26 · Minor · Observability · Connections carry no `application_name`

The pool in `src/sql/sql-driver.ts` sets no `application_name`, so the server's sessions cannot be told apart in `pg_stat_activity`. Default it to `postgres-mcp` when neither the URL nor `PGAPPNAME` sets one. Cancelling a call's statement (see "A cancelled or long-running tool call cannot be stopped") may also need it to find the sessions.

## 2026-11-26 · Minor · Bug · Shutdown does not cover SIGHUP or a closed stdout

`src/server.ts` installs handlers for SIGTERM and SIGINT and reacts to stdin closing, but not to SIGHUP. Whether a reply written after the client closed stdout (EPIPE) ends the process without closing the pool has not been checked; `zaggino/lazy-pg-mcp` records that failure for itself. Handle SIGHUP, and route a stdout `error` through `shutdown()` if the check shows the problem.

## 2026-11-26 · Major · Bug · An unreachable database is reported as a query timeout in restricted mode

`SafeSqlDriver.runWithTimeout` in `src/sql/safe-sql.ts` starts its 30 s timer before `SqlDriver.executeQuery` connects, so the timer also covers `poolConnect()` and `pool.connect()`. The pool's connection timeout in `src/sql/sql-driver.ts` is 30 s as well. When the database host does not answer, the query timer wins the race and the caller gets `Query execution timed out after 30 seconds in restricted mode. Consider simplifying your query or increasing the timeout.`, which points at the query although no statement ran; the connection error is lost. Found by reading the code, not reproduced; `zaggino/lazy-pg-mcp` records the same symptom for upstream 0.3.0. A refused connection fails at once and is not affected, and unrestricted mode has no query timer.

The two cases must be told apart: a database that cannot be reached returns a connection error that names the cause, and only a statement that was sent and ran too long returns the query timeout. Start the query timer once a connection is held, and give connecting its own, shorter timeout.

## 2026-11-26 · Minor · Docs · `AGENTS.md` lacks two rules that `zaggino/lazy-pg-mcp` has

Its agent instructions require the file itself to be updated in the same change that makes a statement in it wrong, and a lesson to be recorded for any non-obvious pitfall, not only after a correction from the user. Its tests follow "one test file per behaviour". Decide which of these to adopt in `AGENTS.md`.

## 2026-11-26 · Major · Bug · Connection pool is invalidated after any query error

`SqlDriver` in `src/sql/sql-driver.ts` calls `markInvalid` on any failure, including a user's syntax error, so the next call reconnects the whole pool. Only connection-level failures should invalidate it.

## 2026-11-26 · Major · Bug · Restricted-mode timeout is client-side only

`SafeSqlDriver.runWithTimeout` in `src/sql/safe-sql.ts` rejects after 30 seconds but never cancels the statement, so it keeps running on the server and holds a pooled connection. Cancelling an MCP tool call does not stop its SQL either. Use `statement_timeout` or `pg_cancel_backend`, and wire the request abort signal through.

## 2026-11-26 · Minor · Bug · Table-size estimate always falls back to 10 MB

`getTableSize` in `src/index/index-opt-base.ts` runs `pg_total_relation_size(quote_ident({}))`; the placeholder is expanded to a string literal and `quote_ident` returns text, which `pg_total_relation_size` does not accept. The query always fails and `estimateTableSize` supplies the fallback, so index-size limits use a wrong table size.

## 2026-11-26 · Minor · Bug · Replication health check returns nothing in restricted mode

`ReplicationCalc` in `src/database-health/replication-calc.ts` uses WAL functions such as `pg_last_wal_receive_lsn()` that are not in the function allowlist in `src/sql/allowlists.ts`. In restricted mode the lag query is rejected and the check reports nothing.

## 2026-11-26 · Minor · Bug · Bind-parameter collector tests `AEXPR_OP` where the original comment says IN

`src/sql/bind-params.ts` matches `kind === "AEXPR_OP"` before visiting a subselect on the right-hand side; the upstream comment describes the `IN` case, which is `AEXPR_IN`. Behaviour is kept from upstream, so `IN (SELECT ...)` is not handled as intended.

## 2026-11-26 · Minor · Bug · `execute_sql`'s `sql` parameter defaults to `"all"`

The `execute_sql` registration in `src/server.ts` defaults `sql` to `"all"`, so a call without it sends `all` to the database and returns a syntax error. The parameter should be required.

## 2026-11-26 · Minor · Bug · Workload SQL is lowercased wholesale

`src/index/index-opt-base.ts` (workload loop in the query analysis, `rawQuery.trim().toLowerCase()`) lowercases the whole query before binding parameters, including string literals and quoted identifiers. This can change the meaning of the query being analysed.

## 2026-11-26 · Minor · Bug · A zero-column SELECT is reported as "no result set"

`executeQuery` in `src/sql/sql-driver.ts` returns `null` for a result with no columns, so `SELECT FROM t` is indistinguishable from a statement without a result set.

## 2026-11-26 · Minor · Bug · Duplicate column names collapse in a row object

Rows in `src/sql/sql-driver.ts` are `Record<string, unknown>`, so `SELECT 1 AS a, 2 AS a` returns one `a` value. Later columns overwrite earlier ones.

## 2026-11-26 · Minor · Bug · Restricted mode rejects `VACUUM <table>` and `ANALYZE <table>`

`VacuumRelation` is not in the node allowlist in `src/sql/allowlists.ts`, so `SafeSqlDriver` in `src/sql/safe-sql.ts` accepts only the bare forms.

## 2026-11-26 · Minor · Bug · Empty or comment-only query passes validation

`SafeSqlDriver` in `src/sql/safe-sql.ts` finds no statements to reject in an empty or comment-only query and sends it to the database.

## 2026-11-26 · Minor · Refactor · Node allowlist contains planner-only node types

The node allowlist in `src/sql/allowlists.ts` includes types that appear only in planned or analysed trees, never in a raw parse tree from `libpg-query`. They are dead entries and obscure what is actually allowed.

## 2026-11-26 · Minor · Bug · Statements that cannot run in a transaction fail in unrestricted mode

`executeWithClient` in `src/sql/sql-driver.ts` wraps every query in `BEGIN`/`COMMIT`, so `CREATE INDEX CONCURRENTLY`, `VACUUM` and similar fail. Upstream behaves the same through its implicit psycopg transaction.

## 2026-11-26 · Minor · Refactor · GROUP BY branch in the bind-parameter collector is dead

`src/sql/bind-params.ts` checks `SortGroupClause` for GROUP BY items. That node type never occurs in a raw parse tree, so the branch never runs and grouped columns are collected by other paths only.

## 2026-11-26 · Minor · Bug · Column collection stops after a nested SELECT

`ColumnCollector` in `src/sql/bind-params.ts` resets its `inside_select` state when it leaves a nested SELECT, so columns after a subquery in the same scope are not collected.

## 2026-11-26 · Minor · Bug · Derived-table aliases are treated as table names

`TableAliasVisitor` in `src/sql/bind-params.ts` records a subquery alias as a table. The statistics lookup then queries `pg_stats` for a table that does not exist, and the fallback key `most_common_vals` is never selected by the stats query.

## 2026-11-26 · Minor · Bug · Parameter replacement works on the original query and mishandles `$10`

`SqlBindParams.replaceParameters` in `src/sql/bind-params.ts` runs column extraction and BETWEEN matching on the original query, and replacing `$1` also hits the prefix of `$10`. Queries with ten or more parameters get wrong bindings.

## 2026-11-26 · Minor · Bug · Unqualified columns are assigned to the first table in scope

`src/sql/bind-params.ts` attributes every unqualified column to the first table in the query. In joins this looks up statistics for the wrong table.

## 2026-11-26 · Minor · Bug · Column names are embedded unescaped in regular expressions

`identifyParameterColumn` and the rewrite helpers in `src/sql/bind-params.ts` build regexes from raw column names. Names with regex metacharacters mis-match, and `identifyParameterColumn` swallows the resulting invalid-regex error where upstream raised it.

## 2026-11-26 · Minor · Bug · Rewrite regexes use ASCII-only `\w`

Regexes in `src/sql/bind-params.ts` use `\w`, which in JavaScript matches ASCII only, so non-ASCII column names are truncated. Use `\p{L}` with the `u` flag.

## 2026-11-26 · Minor · Bug · BETWEEN replacement inserts statistics values literally

`replaceParameters` in `src/sql/bind-params.ts` inserts stat values as replacement text. Upstream processed backslash escapes in them and raised on invalid ones; here text values are quoted as SQL literals and numbers are inserted as text, so no escapes are processed.

## 2026-11-26 · Minor · Bug · `pg_stats` integers above 2^53 lose precision

Statistics values in `src/sql/bind-params.ts` pass through `number`, so very large `bigint` histogram bounds are rounded before being bound into the query.

## 2026-11-26 · Minor · Bug · Empty hypothetical-index plan path needs a tracer

`explainWithHypotheticalIndexes` in `src/explain/explain-plan.ts` fails with an error when the hypothetical index list is empty and no DTA tracer is supplied, instead of returning the infinite-cost fallback plan.

## 2026-11-26 · Minor · Bug · Infinite-cost fallback plan cannot become an artifact

The fallback plan built in `src/explain/explain-plan.ts` has no `Node Type`, so `ExplainPlanArtifact` in `src/artifacts.ts` cannot be created from it.

## 2026-11-26 · Minor · Other · Plan diff hunks can differ from upstream

`src/artifacts.ts` uses `diff` (jsdiff) where upstream used `difflib`. Both produce valid diffs, but hunk alignment can differ, so output is not byte-identical to upstream.

## 2026-11-26 · Minor · Bug · A never-used sequence makes the whole health check fail

`SequenceHealthCalc` in `src/database-health/sequence-health-calc.ts` converts `last_value` with `toBigInt`, which fails on `NULL` for a sequence that has never been used. The error aborts the whole `analyze_db_health` call.

## 2026-11-26 · Minor · Bug · NULL replication lag disables lag checks permanently

`ReplicationCalc` in `src/database-health/replication-calc.ts` treats a `NULL` lag as an unsupported feature and never re-checks it for the lifetime of that instance.

## 2026-11-26 · Minor · Bug · Physical replication slot prints `(database: None)`

The slot formatter in `src/database-health/replication-calc.ts` prints the database as `None` for physical slots, which have no database. The spelling is kept from the Python original.

## 2026-11-26 · Minor · Bug · Error message prefix is missing a word

`src/top-queries/top-queries-calc.ts` returns "Error resource-intensive queries:" where "Error getting resource-intensive queries:" is meant. The text is kept from upstream.

## 2026-11-26 · Minor · Bug · Index-health column split breaks on expression indexes

`src/database-health/index-health-calc.ts` splits column lists on `", "`, so an expression index containing a comma is split into bogus columns.

## 2026-11-26 · Minor · Bug · Vacuum health default `maxValue` looks like a typo

`src/database-health/vacuum-health-calc.ts` defaults `maxValue` to 2146483648, probably meant to be 2147483647 (2^31 - 1). Kept from upstream.

## 2026-11-26 · Minor · Bug · Index recommendations drop the long-text warning

`src/index/presentation.ts` rebuilds recommendations as fresh objects without `potentialProblematicReason` or the size, so the long-text warning set in `src/index/dta-calc.ts` never reaches the output.

## 2026-11-26 · Minor · Refactor · Seed-column handling in the advisor is partly dead

`seedColumnsCount` and `minColumnUsage` in `src/index/dta-calc.ts` are only partly used because the seed pass is commented out upstream.

## 2026-11-26 · Minor · Bug · Condition column collector ignores nested joins

`ConditionColumnCollector` in `src/index/dta-calc.ts` processes the quals of top-level `JoinExpr` items only, so index candidates from nested joins are missed.

## 2026-11-26 · Minor · Refactor · `workload` argument of `analyze_workload` is unused

`TextPresentation` in `src/index/presentation.ts` accepts the workload but never uses it.

## 2026-11-26 · Minor · Bug · Number formatting rounds half up instead of half to even

Costs and sizes are formatted with `toFixed` (for example in `src/index/index-opt-base.ts` and `src/artifacts.ts`), which rounds exact binary ties up. Python rounded half to even, so the last digit can differ.

## 2026-11-26 · Minor · Bug · Time limit is not hit immediately without `analyzeWorkload`

`analysisStartTime` in `src/index/dta-calc.ts` defaults to 0 and is compared with `performance.now()`. Calling `enumerateGreedy` without `analyzeWorkload` therefore does not stop at the time limit at once, as Python did.

## 2026-11-26 · Minor · Bug · `analyze_db_health` has no error handling

`analyzeDbHealth` in `src/server.ts` lets failures propagate as MCP errors instead of returning an error text like the other tools.

## 2026-11-26 · Minor · Bug · `explain_query` rejects `hypothetical_indexes: null`

The zod schema in `src/server.ts` accepts only an array, while the Python tool accepted `None`. Clients that send `null` get a validation error.

## 2026-11-26 · Minor · Bug · `getPostgresVersion` rejects pre-release versions

`getPostgresVersion` in `src/sql/extension-utils.ts` cannot parse server versions such as `17beta1`, so the version lookup fails on a pre-release server.

## 2026-11-26 · Minor · Bug · `explain_query` splits a string `columns` value into characters

`toColumnList` in `src/explain/explain-plan.ts` treats a string `columns` value as an iterable and splits it into characters. The zod schema in `src/server.ts` also leaves hypothetical index entries untyped, so nothing rejects the bad shape.

## 2026-11-26 · Minor · Bug · Missing or non-numeric costs and NULL counters become 0

Plan costs and NULL counters are coerced with `Number()` in `src/index/index-opt-base.ts` and `src/database-health/vacuum-health-calc.ts`, so a missing or non-numeric value silently turns into 0 instead of being reported.

## 2026-11-26 · Minor · Security · Publishing has no approval gate

The `main` environment that `.github/workflows/release-please.yml` publishes from only restricts deployments to the `main` branch, so merging a release PR (or dispatching the workflow with `publish`) publishes to npm without a second person's approval. Required reviewers cannot simply be added to `main`: the `release-please` job uses it too and would then wait for approval on every push. Move the `publish` job to its own environment (and the npm trusted publisher with it) with required reviewers, "Prevent self-review" on and admin bypass off, or the person who triggers a run can approve it alone. (Creating `v*` tags, which the publish guard trusts, is already limited to admins by the "release tags: creation" ruleset.)

## 2026-11-26 · Minor · Bug · A failed query destroys its pooled connection

`SqlDriver.executeQuery` in `src/sql/sql-driver.ts` calls `client.release(true)` after any failure, so a user's syntax error discards a healthy connection.

## 2026-11-26 · Minor · Refactor · `ALLOWED_EXTENSIONS` is unreachable in restricted mode

`CREATE EXTENSION` cannot run in a read-only transaction, so the allowlist in `src/sql/allowlists.ts` never takes effect. Trim it or document why it stays.

## 2026-11-26 · Minor · Tests · Index advisor integration tests can mask a regression

`tests/integration/dta-calc.test.ts` skips when no recommendation is produced and retries twice, so a regression that stops recommendations can pass.

## 2026-11-26 · Minor · Bug · Sequence health treats `smallint` sequences as `bigint`

`src/database-health/sequence-health-calc.ts` computes the maximum value of every sequence as if it were `bigint`, so `smallint` sequences are never reported as near exhaustion.

## 2026-11-26 · Major · Refactor · Split `src/server.ts`

`src/server.ts` is about 1,100 lines and still holds the tool handlers, tool registration, the SSE and streamable HTTP servers with their request handling, stdio, and startup and shutdown (CLI parsing is in `src/cli.ts`; `src/transports/` holds only the request guard and the session store so far). Move the rest into `src/transports/` (stdio, SSE, streamable HTTP, shared HTTP helpers), a tools module and `src/main.ts`. Replace the exported mutable `runners` test seam with parameters (`deps` has its own entry below, as does the repeated try/catch envelope).

## 2026-11-26 · Major · Refactor · `ConditionColumnCollector` inherits from a class it does not use

`ConditionColumnCollector` in `src/index/dta-calc.ts` extends `ColumnCollector` (`src/sql/bind-params.ts`) but overrides or disables all of its behaviour and redeclares its state under new names. Make it extend `Visitor` directly, move it to its own file, and share the scope and alias helpers between the two collectors.

## 2026-11-26 · Major · Refactor · Cross-cutting helpers are redeclared per module

`errorMessage` is defined in 9 modules, stderr logging helpers in five, `isJsonObject` in three, and the Python-format helpers are spread over `src/index/index-opt-base.ts`, `src/index/dta-calc.ts`, `src/sql/bind-params.ts` and `src/explain/explain-plan.ts` although `src/py-format.ts` exists. Give each one home (`src/log.ts`, `src/errors.ts`, `src/py-format.ts`) while keeping stderr output unchanged.

## 2026-11-26 · Major · Refactor · AST struct-shape table lives in the security allowlist file

`STRUCT_FIELD_TYPES` in `src/sql/allowlists.ts` describes parse-tree shape, not policy, and `src/sql/pg-ast.ts` imports it from there. Move it next to the parser, add `IndexStmt.relation`, and expose one value classifier that both the visitor traversal (`pg-ast.ts`) and the validator (`src/sql/safe-sql.ts`) use, so the two walkers cannot disagree.

## 2026-11-26 · Minor · Refactor · Python-shaped data contracts

`RowResult { cells }` wraps every row and each module decodes cells ad hoc; `QueryWeight` and `IndexConfiguration` are positional tuples; several functions return `[boolean, string]`; `IndexRecommendation` is mostly forwarding getters. Replace them with plain row records, named object shapes and shared cell readers.

## 2026-11-26 · Minor · Tooling · `promise-function-async` and `strict-boolean-expressions` are switched off

`oxlint.config.ts` switches off `typescript/promise-function-async` (50 findings) and `typescript/strict-boolean-expressions` (40) because some of their fixes change behaviour.

Of the `promise-function-async` findings, 24 are in `tests/`, and most of the rest are one-line delegations or the tool callbacks in `src/server.ts`, which can be marked `async` mechanically. About ten need judgement, because marking them `async` turns a synchronous throw into a rejection: `SafeSqlDriver.executeParamQuery` (`src/sql/safe-sql.ts`), `poolConnect` (`src/sql/sql-driver.ts`), and the methods with default parameters in `src/index/presentation.ts` and `src/database-health/buffer-health-calc.ts`.

Replacing a truthiness check on a nullable string or boolean changes which values pass, for example `""`. Triage these five first, because they are not that case:

- `!this.timeout` in `src/sql/safe-sql.ts`, where `0` means no timeout.
- `any` values in conditionals in `src/database-health/index-health-calc.ts`, `src/index/dta-calc.ts`, `src/index/index-opt-base.ts` and `src/server.ts`.

Go through the findings, keep the upstream behaviour (or record a deliberate difference), and switch the rules back on.

## 2026-11-26 · Minor · Bug · Objects, arrays and dates are stringified differently from Python `str()`

Eight sites, each marked with an inline `typescript/no-base-to-string` disable, turn an `unknown` value into text with `String(value)` where upstream used `str()`:

- `nullableText` in `src/database-health/constraint-health-calc.ts` and in `src/database-health/index-health-calc.ts`
- `src/database-health/replication-calc.ts`
- `src/sql/extension-utils.ts`
- `src/sql/literal.ts`
- `src/sql/bind-params.ts`
- `src/index/index-opt-base.ts`
- `src/index/dta-calc.ts`

The two agree for strings and numbers, but not for the parsed `json`/`jsonb` objects, arrays and `Date` values that `pg` returns:

- `[object Object]` instead of `{'a': 1}`
- `1,2` instead of `[1, 2]`
- the JavaScript date form instead of Python's

`src/sql/literal.ts` puts the result into SQL array-literal text. Route the sites through one shared cell-to-text helper, which is the "shared cell readers" step of "Python-shaped data contracts", and decide there which values need Python's form.

## 2026-11-26 · Minor · Dependencies · The MCP SDK deprecates the SSE server transport

`SSEServerTransport` (used in `src/server.ts`) and `SSEClientTransport` (used in `tests/unit/http-transports.test.ts`) are deprecated in `@modelcontextprotocol/sdk`. Each use carries an inline `typescript/no-deprecated` disable, because `--transport=sse` is part of the upstream CLI surface. When the SDK removes the transport, upstream parity and the SDK conflict, and that will need a decision. Once the planned `src/transports/` split (see "Split `src/server.ts`") is done, one file-level disable in the SSE module can replace the per-line ones.

## 2026-11-26 · Major · Infra · The first npm publish has to be done by hand

`.github/workflows/release-please.yml` publishes through npm trusted publishing, which is configured on an existing package, and `@zaggino/postgres-mcp` has never been published. The workflow's publish of 0.4.0 will fail; publish 0.4.0 by hand from the `v0.4.0` tag, then configure the trusted publisher (repository `zaggino/postgres-mcp`, workflow `release-please.yml`, environment `main`) so later releases publish themselves.

## 2026-11-26 · Minor · Feature · Server discovery needs a URL-form server URI

Discovery of the databases on a config `servers` entry builds each database URI by replacing the path of the server URL (`#discoverSource` in `src/database-registry.ts`), so the server `uri` must be a `postgres://` or `postgresql://` URL. Key/value DSNs and `dbname=` query parameters are not supported and are reported as an error for that server. Support them by rewriting the `dbname` of a DSN or query string.

## 2026-11-26 · Minor · Feature · Discovered databases with reserved characters in their names cannot be used

`pg-connection-string` decodes the URL path with `decodeURI`, which leaves `%2F`, `%3F`, `%23` and the other reserved escapes in place, so `databaseUri` in `src/database-registry.ts` reports a discovered database named like `a/b` as an error instead of connecting (it would otherwise reach a database literally named `a%2Fb`). Support such names by passing the database name through the pool config instead of the URL.

## 2026-11-26 · Minor · Performance · Unknown database names rerun discovery and open pools have no cap

`DatabaseRegistry.use` in `src/database-registry.ts` reruns discovery on every server for each unknown `database` value, so a model looping over wrong names queries every server each time. Each database used gets its own pool (up to 5 connections) that stays open for `idleMinutes`, with no limit on how many are open at once, so a server with many databases can reach `max_connections`. Add a short negative cache for unknown names, and a cap on open pools.

## 2026-11-26 · Minor · Refactor · `deps.getSqlDriver` duplicates the registry's driver factory

`DatabaseRegistry` takes a `getSqlDriver` option, yet `src/server.ts` still exports the mutable `deps` object, and `main` and `tests/support/registry.ts` bridge the two with the same lambda (so the test helper imports the whole server module). Delete `deps`, give `createTestRegistry` a `getSqlDriver` option, and move the four `vi.spyOn(deps, 'getSqlDriver')` sites in `tests/unit/explain/` to it.

## 2026-11-26 · Minor · Refactor · Tool handlers repeat the same try/catch envelope

Eight handlers in `src/server.ts` each wrap their body in `try { … } catch { log('ERROR', …); return formatError(…) }`, while `onDatabase` in `createServer` already wraps every call. Give `onDatabase` a log label and let it own the catch, which also handles `DatabaseAccessError` in one place. `analyze_db_health` has no envelope today and its errors reach the MCP SDK; it needs an opt-out to stay behaviour-identical. Do it together with one `registerDatabaseTool(name, config, (sqlDriver, args) => …)` helper that adds the `database` schema and the wrapping, so the nine registrations stop repeating both (a generic helper over the SDK's `registerTool` needed casts the first time; try typing it against `z.ZodRawShape` again).

## 2026-11-26 · Minor · Refactor · Small cleanups left over from the multi-database review

`MAX_IDLE_MINUTES` is a `setTimeout` limit that belongs next to `IdlePool` in `src/database-registry.ts`, not in `src/cli.ts`. `SqlDriver.conn` in `src/sql/sql-driver.ts` is `DbConnPool | null` only for the `engineUrl` path, so its `pool` getter converts `null` to `undefined`; an optional field removes the conversion.

## 2026-11-26 · Minor · Refactor · Server URIs are validated in two places

`configServer` in `src/config.ts` checks a server `uri` only when it has no `${VAR}`, so `#discoverSource` in `src/database-registry.ts` checks it again after expansion on every discovery run, and `config.ts` imports `isPostgresUrl` and `NOT_A_POSTGRES_URL` from the registry for that. Validate once in `config.ts` after expansion (a fatal `CliError` for a literal URI, a `{ error }` spec for an expanded one), seed `SourceState.error` and the source pool in the registry constructor, and drop the re-check, the lazy pool creation inside the `try` and the dead `'error' in source.uri` ternary in `list()`.

## 2026-11-26 · Minor · Refactor · `SqlExecutor.pool` exists only to key the version cache

`getPostgresVersion` in `src/sql/extension-utils.ts` keys its cache by `sqlDriver.pool ?? sqlDriver`, because `DatabaseRegistry.use` builds a new driver on every call; that put an optional `pool` member on `SqlExecutor` with pass-through getters on `SafeSqlDriver` and `SqlDriver`, and the key of an `engineUrl` driver changes between the read and the write. Let `IdlePool` hold one driver per connection, key the cache by the driver, and remove `pool` from the interface.

## 2026-11-26 · Minor · Refactor · Pool retirement is tracked in two places

`IdlePool` in `src/database-registry.ts` has `#retired` and `isFinished`, and the registry keeps its own `#retired` set that `#retireStalePools` sweeps only on the next discovery. Let `retire()` return a promise that settles once the pool has drained and closed, and remove the pool from the set when it settles; `isFinished` and the sweep go.

## 2026-11-26 · Minor · Observability · `list_databases` does not show why a database cannot connect

When an explicit database fails to connect, `DbConnPool.close` drops the pool and `list_databases` reports it as `closed` with no error, the same as an idle pool. `DbConnPool.lastError` has the reason, but `SqlDriver.executeQuery` also sets it on every SQL error (the entry "Connection pool is invalidated after any query error"), so showing it now would mark a database as broken after a typo. Fix that entry first, then add a masked `last_error` to each database in `list_databases`.

## 2026-11-26 · Minor · Tests · Gaps in the multi-database tests

Untested so far: `--idle-minutes` and config `idleMinutes` above 35791 are rejected; `list_databases` shows `open` with a counting-down `idle_seconds_left` after a successful call; a server whose `${VAR}` is unset shows the error in `servers[].error` and its databases are unknown; an invalid `--database` name, a duplicate name, an unreadable config file. Add one case each to `tests/unit/config.test.ts` and `tests/unit/database-registry.test.ts`.

## 2026-11-26 · Minor · Bug · An SSE session can be closed during a tool call longer than the idle time

On SSE, `POST /messages` returns 202 before the tool runs and the result travels over the `GET /sse` stream, so `SessionStore` (`src/transports/sessions.ts`) sees no request in flight while a tool call runs. A call longer than `--session-idle-minutes` with no other message from the client closes the session and the result is lost. Streamable HTTP is unaffected: its response carries the result and keeps the session held. Fix by tracking pending tool calls per SSE session (for example through the McpServer request handlers).

## 2026-11-26 · Minor · Refactor · Session and pool idle timers are two implementations

`SessionStore` in `src/transports/sessions.ts` and `IdlePool` in `src/database-registry.ts` each hold a per-entry `setTimeout`, with the in-flight rule and `unref` written twice. A shared `IdleTimer` (start, pause while busy, clear) would serve both.

## 2026-11-27 · Minor · Refactor · Resolve each discovery server once instead of per discovery and per listing

`src/database-registry.ts` parses a server's URI in `isPostgresUrl`, `serverUriWithDefaults` and `serverLabel` on every discovery and every `list_databases`, and `#discoverSource` and `list()` each branch on `'uri' in source.uri`. The source URI cannot change after construction, so resolve it once when the registry is built into `{ uri, label } | { error }` (protocol check, port and database defaults, label) and keep it on `SourceState`. That removes the repeated parsing and the branches, and the label is then the host of the connect URI by construction. Decide whether a non-postgres URI keeps its host label next to its error.

## 2026-11-27 · Minor · Tests · An explicit database in a server URI is not tested to survive the defaults

The port is covered: `tests/unit/list-databases.test.ts` labels a `:5433` server and `tests/unit/database-registry.test.ts` a `?port=6543` one. The database is not: every discovery test either leaves it out or uses `/postgres`, which equals the default, so a bug in `serverUriWithDefaults` that always replaced the database would pass. Add a case with an explicit non-default database (for example `postgresql://u:p@h:6543/other`: discovery connects to `other`) and one for the trailing-slash form `postgresql://u:p@h:6543/` (database becomes `postgres`, port kept).

## 2026-11-27 · Minor · Performance · `list_databases` output repeats the same fields for every database

Each entry in the `list_databases` result (`DatabaseRegistry.list()` in `src/database-registry.ts`) carries `source`, `state` and `idle_seconds_left`, mostly as `"server"`, `"closed"` and `null`. With 30 discovered databases one call costs about 1.5k tokens of an agent's context, most of it repetition. Group the databases under their source and leave out null and default fields (for example list closed databases by name only), which should cut the output by more than half. `list_databases` is a fork-only tool, so its output shape is not pinned to upstream, but the tests in `tests/unit/list-databases.test.ts` and the `list()` tests in `tests/unit/database-registry.test.ts` need updating.

## 2026-11-27 · Minor · Bug · Object listings read `information_schema`, which hides objects the role cannot access

`list_schemas`, `list_objects` and `get_object_details` in `src/server.ts` query `information_schema.schemata`, `.tables`, `.sequences`, `.columns` and `.table_constraints`. Those views show only objects the current role owns or holds a privilege on, so a role without grants gets `[]` for a schema that has tables, which looks like an empty schema rather than missing permissions. Seen with a read-only role on a database with ~150 tables: `list_objects` style queries returned nothing while `pg_tables` listed all of them. Inherited from upstream. A divergence would read `pg_catalog` (`pg_namespace`, `pg_class`, `pg_attribute`, `pg_constraint`) and report what the role can do with each object, using the privilege check for its kind (`has_table_privilege` for tables and views, `has_sequence_privilege` for sequences). Visibility also differs by view: a role with SELECT on a table sees its columns, but `information_schema.table_constraints` shows constraints only to the table's owner or a role with a privilege other than SELECT, so `get_object_details` can show a readable table without its constraints. Check every query stays within the restricted-mode allowlists.

## 2026-11-27 · Minor · Docs · Server instructions do not say discovered names carry a prefix

A database discovered on a config `servers` entry with a `prefix` is exposed as `<prefix><name>` (for example `dev-sales`), while `current_database()` and anything else inside Postgres report `sales`. `serverInstructions` in `src/server.ts` does not mention the mapping, so an agent can take the mismatch for a wrong connection. A clause such as "discovered names carry their server's prefix; inside the database the name is unprefixed" costs about 20 tokens per session. Add it only if agents are seen tripping on it.

## 2026-11-27 · Minor · Bug · Shutdown waits without limit for running statements

`shutdown()` in `src/server.ts` awaits `registry.closeAll()`, which ends every pool with `pool.end()`. node-postgres resolves `pool.end()` only once every client is released, including clients still running a statement, so shutdown lasts as long as the longest running call: up to 30 s in restricted mode and with no bound in unrestricted mode. On stdio this starts when the client closes stdin. A client that does not kill the server leaves it running until the statement finishes. A client that does kill it after a short grace period leaves the statement running in postgres, because postgres does not notice the closed socket while a statement executes. Some clients wait only about half a second between closing stdin and SIGKILL. Bound `closeAll` (a few seconds), then cancel the statements still running and destroy their clients. Fix this together with "A cancelled or long-running tool call cannot be stopped", which needs the same cancel path.
