# TODO

Follow-ups for this repository. Each entry is a heading of the form `## YYYY-MM-DD · <Critical|Major|Minor> · <Type> · <title>` followed by a short body: what happens, where in `src/`, and why it matters. The file is append-only, oldest entries first; delete an entry once it is resolved.

## 2026-11-26 · Major · Bug · Connection pool is invalidated after any query error

`SqlDriver` in `src/sql/sql-driver.ts` calls `markInvalid` on any failure, including a user's syntax error, so the next call reconnects the whole pool. Only connection-level failures should invalidate it.

## 2026-11-26 · Minor · Bug · `DATABASE_URI` overrides the positional database URL

`main` in `src/server.ts` reads `process.env.DATABASE_URI ?? options.databaseUrl`, so the environment variable wins over an explicit argument, and an empty `DATABASE_URI` also wins and fails with "No database URL provided". The explicit argument should take precedence, and an empty variable should count as unset.

## 2026-11-26 · Major · Bug · Restricted-mode timeout is client-side only

`SafeSqlDriver.runWithTimeout` in `src/sql/safe-sql.ts` rejects after 30 seconds but never cancels the statement, so it keeps running on the server and holds a pooled connection. Cancelling an MCP tool call does not stop its SQL either. Use `statement_timeout` or `pg_cancel_backend`, and wire the request abort signal through.

## 2026-11-26 · Minor · Bug · Table-size estimate always falls back to 10 MB

`getTableSize` in `src/index/index-opt-base.ts` runs `pg_total_relation_size(quote_ident({}))`; the placeholder is expanded to a string literal and `quote_ident` returns text, which `pg_total_relation_size` does not accept. The query always fails and `estimateTableSize` supplies the fallback, so index-size limits use a wrong table size.

## 2026-11-26 · Major · Security · Index advisor builds `IN ('…')` lists without escaping

`src/index/dta-calc.ts` (the column type query around `tablesArray` and `columnsArray`) interpolates table and column names into `IN ('…')` lists with plain quoting. Names containing a single quote break the query and can inject SQL. Quote them with the literal helper in `src/sql/literal.ts`.

## 2026-11-26 · Minor · Bug · Replication health check returns nothing in restricted mode

`ReplicationCalc` in `src/database-health/replication-calc.ts` uses WAL functions such as `pg_last_wal_receive_lsn()` that are not in the function allowlist in `src/sql/allowlists.ts`. In restricted mode the lag query is rejected and the check reports nothing.

## 2026-11-26 · Minor · Bug · Bind-parameter collector tests `AEXPR_OP` where the original comment says IN

`src/sql/bind-params.ts` matches `kind === "AEXPR_OP"` before visiting a subselect on the right-hand side; the upstream comment describes the `IN` case, which is `AEXPR_IN`. Behaviour is kept from upstream, so `IN (SELECT ...)` is not handled as intended.

## 2026-11-26 · Minor · Cleanup · `execute_sql`'s `sql` parameter defaults to `"all"`

The `execute_sql` registration in `src/server.ts` defaults `sql` to `"all"`, so a call without it sends `all` to the database and returns a syntax error. The parameter should be required.

## 2026-11-26 · Minor · Bug · Workload SQL is lowercased wholesale

`src/index/index-opt-base.ts` (workload loop in the query analysis, `rawQuery.trim().toLowerCase()`) lowercases the whole query before binding parameters, including string literals and quoted identifiers. This can change the meaning of the query being analysed.

## 2026-11-26 · Minor · Chore · `devenv.lock` not regenerated after removing Python from `devenv.nix`

`devenv.lock` still pins inputs from the Python-based setup. Run `devenv update` to regenerate it.

## 2026-11-26 · Minor · Security · Raw connection error may contain the password

`DbConnPool` in `src/sql/sql-driver.ts` stores the unfiltered message in `lastError`; only the thrown error is passed through `obfuscatePassword`. Anything that reads `lastError` directly can leak credentials.

## 2026-11-26 · Minor · Bug · A zero-column SELECT is reported as "no result set"

`executeQuery` in `src/sql/sql-driver.ts` returns `null` for a result with no columns, so `SELECT FROM t` is indistinguishable from a statement without a result set.

## 2026-11-26 · Minor · Bug · Duplicate column names collapse in a row object

Rows in `src/sql/sql-driver.ts` are `Record<string, unknown>`, so `SELECT 1 AS a, 2 AS a` returns one `a` value. Later columns overwrite earlier ones.

## 2026-11-26 · Minor · Bug · Restricted mode rejects `VACUUM <table>` and `ANALYZE <table>`

`VacuumRelation` is not in the node allowlist in `src/sql/allowlists.ts`, so `SafeSqlDriver` in `src/sql/safe-sql.ts` accepts only the bare forms.

## 2026-11-26 · Minor · Bug · Empty or comment-only query passes validation

`SafeSqlDriver` in `src/sql/safe-sql.ts` finds no statements to reject in an empty or comment-only query and sends it to the database.

## 2026-11-26 · Minor · Cleanup · Node allowlist contains planner-only node types

The node allowlist in `src/sql/allowlists.ts` includes types that appear only in planned or analysed trees, never in a raw parse tree from `libpg-query`. They are dead entries and obscure what is actually allowed.

## 2026-11-26 · Minor · Bug · Statements that cannot run in a transaction fail in unrestricted mode

`executeWithClient` in `src/sql/sql-driver.ts` wraps every query in `BEGIN`/`COMMIT`, so `CREATE INDEX CONCURRENTLY`, `VACUUM` and similar fail. Upstream behaves the same through its implicit psycopg transaction.

## 2026-11-26 · Minor · Cleanup · GROUP BY branch in the bind-parameter collector is dead

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

## 2026-11-26 · Minor · Cleanup · Plan diff hunks can differ from upstream

`src/artifacts.ts` uses `diff` (jsdiff) where upstream used `difflib`. Both produce valid diffs, but hunk alignment can differ, so output is not byte-identical to upstream.

## 2026-11-26 · Minor · Bug · A never-used sequence makes the whole health check fail

`SequenceHealthCalc` in `src/database-health/sequence-health-calc.ts` converts `last_value` with `toBigInt`, which fails on `NULL` for a sequence that has never been used. The error aborts the whole `analyze_db_health` call.

## 2026-11-26 · Minor · Bug · NULL replication lag disables lag checks permanently

`ReplicationCalc` in `src/database-health/replication-calc.ts` treats a `NULL` lag as an unsupported feature and never re-checks it for the lifetime of that instance.

## 2026-11-26 · Minor · Bug · Physical replication slot prints `(database: None)`

The slot formatter in `src/database-health/replication-calc.ts` prints the database as `None` for physical slots, which have no database. The spelling is kept from the Python original.

## 2026-11-26 · Minor · Security · `fracThreshold` is interpolated into SQL text

`TopQueriesCalc.getTopResourceQueries` in `src/top-queries/top-queries-calc.ts` writes the threshold into the query string. Current callers pass a number, but it should be a bound parameter.

## 2026-11-26 · Minor · Cleanup · Error message prefix is missing a word

`src/top-queries/top-queries-calc.ts` returns "Error resource-intensive queries:" where "Error getting resource-intensive queries:" is meant. The text is kept from upstream.

## 2026-11-26 · Minor · Bug · Index-health column split breaks on expression indexes

`src/database-health/index-health-calc.ts` splits column lists on `", "`, so an expression index containing a comma is split into bogus columns.

## 2026-11-26 · Minor · Bug · Vacuum health default `maxValue` looks like a typo

`src/database-health/vacuum-health-calc.ts` defaults `maxValue` to 2146483648, probably meant to be 2147483647 (2^31 - 1). Kept from upstream.

## 2026-11-26 · Minor · Bug · Index recommendations drop the long-text warning

`src/index/presentation.ts` rebuilds recommendations as fresh objects without `potentialProblematicReason` or the size, so the long-text warning set in `src/index/dta-calc.ts` never reaches the output.

## 2026-11-26 · Minor · Cleanup · Seed-column handling in the advisor is partly dead

`seedColumnsCount` and `minColumnUsage` in `src/index/dta-calc.ts` are only partly used because the seed pass is commented out upstream.

## 2026-11-26 · Minor · Bug · Condition column collector ignores nested joins

`ConditionColumnCollector` in `src/index/dta-calc.ts` processes the quals of top-level `JoinExpr` items only, so index candidates from nested joins are missed.

## 2026-11-26 · Minor · Cleanup · `workload` argument of `analyze_workload` is unused

`TextPresentation` in `src/index/presentation.ts` accepts the workload but never uses it.

## 2026-11-26 · Minor · Bug · Number formatting rounds half up instead of half to even

Costs and sizes are formatted with `toFixed` (for example in `src/index/index-opt-base.ts` and `src/artifacts.ts`), which rounds exact binary ties up. Python rounded half to even, so the last digit can differ.

## 2026-11-26 · Minor · Bug · Time limit is not hit immediately without `analyzeWorkload`

`analysisStartTime` in `src/index/dta-calc.ts` defaults to 0 and is compared with `performance.now()`. Calling `enumerateGreedy` without `analyzeWorkload` therefore does not stop at the time limit at once, as Python did.

## 2026-11-26 · Minor · Bug · `analyze_db_health` has no error handling

`analyzeDbHealth` in `src/server.ts` lets failures propagate as MCP errors instead of returning an error text like the other tools.

## 2026-11-26 · Minor · Bug · `explain_query` rejects `hypothetical_indexes: null`

The zod schema in `src/server.ts` accepts only an array, while the Python tool accepted `None`. Clients that send `null` get a validation error.

## 2026-11-26 · Minor · Chore · `SERVER_VERSION` is hard-coded

`SERVER_VERSION` in `src/server.ts` duplicates `package.json` and can drift from it. Read it from `package.json` at build time.

## 2026-11-26 · Minor · Security · Non-loopback HTTP binds have no Host or Origin checks

`hostGuard` in `src/server.ts` enables DNS-rebinding protection only for loopback hosts. A server bound to another address accepts any `Host` and `Origin` and has no authentication.

## 2026-11-26 · Minor · Bug · `getPostgresVersion` rejects pre-release versions

`getPostgresVersion` in `src/sql/extension-utils.ts` cannot parse server versions such as `17beta1`, so the version lookup fails on a pre-release server.

## 2026-11-26 · Minor · Bug · `explain_query` splits a string `columns` value into characters

`toColumnList` in `src/explain/explain-plan.ts` treats a string `columns` value as an iterable and splits it into characters. The zod schema in `src/server.ts` also leaves hypothetical index entries untyped, so nothing rejects the bad shape.

## 2026-11-26 · Minor · Bug · Missing or non-numeric costs and NULL counters become 0

Plan costs and NULL counters are coerced with `Number()` in `src/index/index-opt-base.ts` and `src/database-health/vacuum-health-calc.ts`, so a missing or non-numeric value silently turns into 0 instead of being reported.

## 2026-11-26 · Major · Security · Publish workflow has no approval gate and uses mutable action tags

`.github/workflows/publish.yml` publishes without a protected environment and references actions by mutable tag. Add an environment with required reviewers, pin actions by commit SHA, and prefer npm trusted publishing over `NPM_TOKEN`.

## 2026-11-26 · Minor · Security · HTTP sessions are unbounded and never expire

The session maps in `src/server.ts` grow with every client that initializes and are cleaned up only when the client closes. Add a session limit and an idle timeout.

## 2026-11-26 · Minor · Security · Full SQL text is included in error messages and logs

Error messages returned to the client and written to stderr include the full SQL text (`src/sql/sql-driver.ts`, `src/sql/safe-sql.ts`), which can contain sensitive literals.

## 2026-11-26 · Minor · Bug · A failed query destroys its pooled connection

`SqlDriver.executeQuery` in `src/sql/sql-driver.ts` calls `client.release(true)` after any failure, so a user's syntax error discards a healthy connection.

## 2026-11-26 · Minor · Cleanup · `ALLOWED_EXTENSIONS` is unreachable in restricted mode

`CREATE EXTENSION` cannot run in a read-only transaction, so the allowlist in `src/sql/allowlists.ts` never takes effect. Trim it or document why it stays.

## 2026-11-26 · Minor · Chore · Index advisor integration tests can mask a regression

`tests/integration/dta-calc.test.ts` skips when no recommendation is produced and retries twice, so a regression that stops recommendations can pass.

## 2026-11-26 · Minor · Bug · Sequence health treats `smallint` sequences as `bigint`

`src/database-health/sequence-health-calc.ts` computes the maximum value of every sequence as if it were `bigint`, so `smallint` sequences are never reported as near exhaustion.

## 2026-11-26 · Major · Cleanup · Split `src/server.ts`

`src/server.ts` is about 1,200 lines and holds the tool handlers, tool registration, HTTP plumbing for three transports, CLI parsing, and startup and shutdown. Split it into `src/cli.ts`, `src/transports/` (stdio, SSE, streamable HTTP, shared HTTP helpers), a tools module and `src/main.ts`. Replace the exported mutable test seams (`deps`, `runners`, `dbConnection`) with parameters, for example `createServer(accessMode, getDriver)`. The nine tool handlers repeat one try/catch envelope that a single wrapper would cover.

## 2026-11-26 · Major · Cleanup · `ConditionColumnCollector` inherits from a class it does not use

`ConditionColumnCollector` in `src/index/dta-calc.ts` extends `ColumnCollector` (`src/sql/bind-params.ts`) but overrides or disables all of its behaviour and redeclares its state under new names. Make it extend `Visitor` directly, move it to its own file, and share the scope and alias helpers between the two collectors.

## 2026-11-26 · Major · Cleanup · Cross-cutting helpers are redeclared per module

`errorMessage` is defined in six modules, stderr logging helpers in five, `isJsonObject` in three, and the Python-format helpers are spread over `src/index/index-opt-base.ts`, `src/index/dta-calc.ts`, `src/sql/bind-params.ts` and `src/explain/explain-plan.ts` although `src/py-format.ts` exists. Give each one home (`src/log.ts`, `src/errors.ts`, `src/py-format.ts`) while keeping stderr output unchanged.

## 2026-11-26 · Major · Cleanup · AST struct-shape table lives in the security allowlist file

`STRUCT_FIELD_TYPES` in `src/sql/allowlists.ts` describes parse-tree shape, not policy, and `src/sql/pg-ast.ts` imports it from there. Move it next to the parser, add `IndexStmt.relation`, and expose one value classifier that both the visitor traversal (`pg-ast.ts`) and the validator (`src/sql/safe-sql.ts`) use, so the two walkers cannot disagree.

## 2026-11-26 · Minor · Cleanup · Python-shaped data contracts

`RowResult { cells }` wraps every row and each module decodes cells ad hoc; `QueryWeight` and `IndexConfiguration` are positional tuples; several functions return `[boolean, string]`; `IndexRecommendation` is mostly forwarding getters. Replace them with plain row records, named object shapes and shared cell readers.
