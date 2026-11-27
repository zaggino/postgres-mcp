# postgres-mcp

[![npm version](https://img.shields.io/npm/v/@zaggino/postgres-mcp)](https://www.npmjs.com/package/@zaggino/postgres-mcp)
[![CI](https://github.com/zaggino/postgres-mcp/actions/workflows/build.yml/badge.svg)](https://github.com/zaggino/postgres-mcp/actions/workflows/build.yml)

A Postgres MCP server with index tuning, explain plans, health checks, and safe SQL execution.

> This is a fork of [crystaldba/postgres-mcp](https://github.com/crystaldba/postgres-mcp) (Postgres MCP Pro), rewritten in TypeScript and published on npm as [`@zaggino/postgres-mcp`](https://www.npmjs.com/package/@zaggino/postgres-mcp). Credit for the design, the index tuning approach and the original implementation goes to Crystal DBA.

The fork no longer tracks upstream and fixes inherited defects as it finds them. The notable differences from upstream:

- TypeScript on Node.js 26+ instead of Python.
- Installed from npm. There is no Docker image and no PyPI package.
- Structured tool results are JSON instead of Python repr text.
- The experimental LLM index tuning method (`method="llm"`) is not included. `method` accepts only `"dta"`.
- Restricted mode runs statements in an enforced read-only transaction.
- The default access mode is `restricted`. Upstream defaults to `unrestricted`.
- SQL is parsed with the PostgreSQL 18 grammar (`libpg-query`) instead of the PostgreSQL 17 grammar (pglast).
- Sample values taken from table statistics are quoted as literals when the index advisor fills query parameters. Upstream inserted them into the SQL unescaped.
- The index advisor quotes table and column names as literals in its catalog lookup. Upstream inserted them into the SQL unescaped.
- An `Error: ...` tool result sets `isError` when the SQL got no answer from Postgres (unknown database, configuration or connection failure including a FATAL report from Postgres, restricted-mode refusal, statement timeout or cancellation, a rejected argument value); the text is unchanged. Upstream returns every failure as a plain text result. `analyze_db_health`, `get_top_queries` and the two index tools still report their failures in their output, as upstream does.
- Error messages and stderr logs do not include the SQL text, plans or parse trees of a query. Upstream included the full query. A database or parser error can still quote the token it failed at.
- Index advisor results are deterministic. Upstream's depended on Python set ordering.
- Plan diffs are computed with jsdiff instead of Python's `difflib`, so hunks can be aligned differently.
- Numbers are rounded with JavaScript's `toFixed`, which rounds exact ties up where Python rounds them to even, so a last digit can differ.
- The HTTP transports check the `Host` and `Origin` headers of every request against an allow-list (`--allowed-hosts`, `--allowed-origins`), and the server refuses to start on a non-loopback bind without `--allowed-hosts`. Request bodies are limited to 4 MB. HTTP sessions are capped (`--max-sessions`) and expire when idle (`--session-idle-minutes`); upstream has neither.
- Statement timeouts are enforced by Postgres (`statement_timeout`), so a statement that runs too long is stopped; `--statement-timeout` sets the limit in either mode (default 30 seconds in restricted mode, none in unrestricted mode). Upstream stops waiting after 30 seconds in restricted mode and leaves the statement running.
- Cancelling a tool call (`notifications/cancelled`) cancels its running statement in Postgres. In unrestricted mode a new `cancel_query` tool lists the session's running calls and cancels one by id. Upstream ignores cancellation.
- Only a connection-level failure (a lost connection, any error that is not from Postgres, a FATAL error, or SQLSTATE class 08 or 28, 53300, 57P01 to 57P03) invalidates a database's pool and discards its connection. A statement Postgres rejects leaves both in use. Upstream reconnects the whole pool after any error, a syntax error included.
- Opening a connection times out after 10 seconds; waiting for a free connection in a busy pool still times out after 30. Upstream waits 30 seconds for either. A cancelled call stops waiting for a connection at once and gives up its place in the queue.
- Connections set `application_name` to `postgres-mcp` unless the connection URI or `PGAPPNAME` sets one.
- The SQL comment marker is `/* postgres-mcp */` and hypothetical index names start with `postgres_mcp_idx_`.
- One server serves many databases. Every database tool takes a required `database` argument and there is a new `list_databases` tool, so the tool schemas differ from upstream. Databases are named with `--database` flags or a `--config` file, which can also discover the databases of a server; pools open lazily and close when idle (`--idle-minutes`). `DATABASE_URI` and the positional `database_url` are removed. See [Multiple databases](#multiple-databases).

## Overview

postgres-mcp is a Model Context Protocol (MCP) server for working with a Postgres database from an AI agent, from initial coding through testing and deployment to production tuning and maintenance.

Features:

- **Database health**: analyze index health, connection utilization, buffer cache, vacuum health, sequence limits, replication lag, and more.
- **Index tuning**: search for the best set of indexes for your workload with a greedy search adapted from an industrial index advisor.
- **Query plans**: review EXPLAIN plans and simulate the effect of hypothetical indexes.
- **Schema information**: list schemas, objects, and object details so the agent can write correct SQL.
- **Safe SQL execution**: configurable access control, including a read-only mode with SQL parsing, for both development and production.

The server supports the [stdio](https://modelcontextprotocol.io/docs/concepts/transports#standard-input%2Foutput-stdio), [SSE](https://modelcontextprotocol.io/docs/concepts/transports#server-sent-events-sse) and streamable HTTP transports.

## Quick Start

### Prerequisites

1. Access credentials for your database. You can check them with `psql` or a GUI tool such as [pgAdmin](https://www.pgadmin.org/).
2. Node.js 26 or higher.

### Run the server

Name each database with a `--database` flag. Its [Postgres connection URI](https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-CONNSTRING-URIS) is read from the environment variable `MCP_<NAME>_DATABASE_URI` (name uppercased, `-` replaced by `_`), so `--database=app` reads `MCP_APP_DATABASE_URI`.

```bash
MCP_APP_DATABASE_URI="postgresql://user:pass@host:5432/db" \
  npx -y @zaggino/postgres-mcp --database=app --access-mode=restricted
```

To run from source instead:

```bash
git clone https://github.com/zaggino/postgres-mcp.git
cd postgres-mcp
pnpm install && pnpm build
MCP_APP_DATABASE_URI="postgresql://user:pass@host:5432/db" \
  node dist/index.js --database=app --access-mode=restricted
```

Or pass `--config=/path/to/postgres-mcp.config.jsonc` to use a [config file](#multiple-databases) instead. `--database` and `--config` are mutually exclusive, and one of them is required.

### Configure your AI assistant

A single `mcpServers` entry serves every database, so the client carries one tool list in its context however many databases you use; the agent picks the database with the `database` argument of each tool.

**Claude Code.** Copy [.mcp.example.json](.mcp.example.json) to `.mcp.json` in your project root and replace `/path/to/postgres-mcp` with the path of your clone, built as shown in [Run the server](#run-the-server). It runs the server from source in restricted mode for the databases `app` and `analytics` and reads their URIs from the `MCP_APP_DATABASE_URI` and `MCP_ANALYTICS_DATABASE_URI` environment variables of the shell that starts Claude Code, so no credentials are stored in the file. To use a config file instead, copy [.mcp.config-example.json](.mcp.config-example.json) and point `--config` at your file (see [Multiple databases](#multiple-databases)).

**Codex.** Add the server to `~/.codex/config.toml`:

```toml
[mcp_servers.postgres]
command = "node"
args = ["/path/to/postgres-mcp/dist/index.js", "--access-mode=restricted", "--database=app"]

[mcp_servers.postgres.env]
MCP_APP_DATABASE_URI = "postgresql://username:password@localhost:5432/dbname"
```

To run the published package instead of a clone, use `npx` as the command and `"-y", "@zaggino/postgres-mcp"` in place of the path.

### Access modes

- **Unrestricted**: full read/write access to data and schema. Suitable for development.
- **Restricted**: SQL is parsed and checked against allowlists of statements, node types and functions, executed in a read-only transaction, and each statement is limited to 30 seconds by default. Suitable for production.

Select the mode with `--access-mode=restricted` (the default) or `--access-mode=unrestricted`.

Postgres cancels any statement that runs longer than `--statement-timeout` seconds (default 30 in restricted mode, none in unrestricted mode; `0` disables it). Postgres enforces the limit itself (`SET statement_timeout` on the connection before each call), so a statement is stopped even if the server stops waiting for it. In unrestricted mode, SQL can change `statement_timeout` itself. Cancelling a tool call from the client cancels its running statement. In unrestricted mode the `cancel_query` tool lets the agent do the same: called without arguments it lists the session's running calls, and with a `call_id` it cancels that call. This only helps when the client can make a call while another is running, or has given up waiting for one.

## Multiple databases

One server process serves every database you name. Every tool except `list_databases` (and `cancel_query` in unrestricted mode) takes a required `database` argument, and the server's instructions tell the client so. The instructions also state the access mode and its timeout, how to tell server failures from Postgres errors, how to diagnose a failure, and where to report problems with the server. `list_databases` returns:

```
{ databases: [{ database, source, state, idle_seconds_left, error?, last_error? }], servers: [{ server, prefix, error? }] }
```

- `source` is `cli`, `config` or `server` (discovered); `state` is `open`, `closed` or `error`; `idle_seconds_left` is the time until an open pool closes, or `null`.
- `error` is a configuration problem that keeps the database from being used; `last_error` is why the last call could not reach the database (password masked), and disappears once a call reaches it.
- `servers[].server` is the server's `host:port` only (no user name, password or query parameters); `error` reports a failed discovery.

### Config file

`--config FILE` reads a JSONC file (JSON with `//` and `/* */` comments and trailing commas; plain JSON works too); see [postgres-mcp.config.example.jsonc](postgres-mcp.config.example.jsonc). Unknown keys are rejected, every key is optional, but at least one database or server is required.

| Key                       | Default                           | Description                                                                                                                                     |
| ------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `accessMode`              | `restricted`                      | `unrestricted` or `restricted`. `--access-mode` wins.                                                                                           |
| `idleMinutes`             | `10`                              | Minutes without a call in flight before a pool closes; `0` never closes; at most 35791 (the longest timer Node accepts). `--idle-minutes` wins. |
| `statementTimeoutSeconds` | `30` restricted, `0` unrestricted | Seconds after which Postgres cancels a statement; `0` means none; at most 2147483. `--statement-timeout` wins.                                  |
| `databases`               | none                              | Map of database name to `{ "uri": ... }`. Names are free-form strings.                                                                          |
| `servers[].uri`           | required                          | A `postgres://` or `postgresql://` URL of a server whose databases are discovered; port and database are optional.                              |
| `servers[].prefix`        | `""`                              | Prepended to each discovered database name.                                                                                                     |
| `servers[].include`       | `["*"]`                           | Globs of database names to keep.                                                                                                                |
| `servers[].exclude`       | `[]`                              | Globs of database names to drop.                                                                                                                |

Globs support `*` and `?` only and are matched against the whole database name (before the prefix). Discovery lists `pg_database` entries that allow connections and are not templates. It connects with the server URI, defaulting the port to `5432` and, when the URI names no database, the database to `postgres` (not the user name, as `pg` would), so `postgresql://user:password@host` is enough; `PGPORT` and `PGDATABASE` are not consulted for server URIs. A discovered database is reached with the server URI whose path is replaced by the database name, so discovery needs a URL-form server URI: key/value DSNs and a `dbname=` query parameter are not supported.

If the same name is found on more than one server, calls to it fail until you set distinct `prefix` values. An explicitly named database wins over a discovered one with the same name.

### URIs and environment variables

A `uri` is either a literal URI or contains `${VAR}` references that are expanded from the environment. The config file lives outside the repository, so literal URIs with passwords are fine there; use `${VAR}` when the file is shared. An unset or empty variable counts as unset. It does not stop the server: the entry reports `environment variable VAR is not set` when called and in `list_databases`. A literal server `uri` that is not a postgres URL fails at startup (`invalid config: servers.N.uri: ...`); one that comes from a `${VAR}` fails at discovery time and shows in `servers[].error`.

The server reads variables from its own environment. Claude Code passes its environment to the server. Clients that do not pass their environment need an `env` block in their config; alternatively load a file with Node: `node --env-file=/path/.env dist/index.js ...`.

Treat a config file like code you run: `${VAR}` can read any variable of the server's environment and send it to the host the file names. Only point `--config` at files you trust.

### Lifecycle

Pools open on the first call to a database, and the server makes no connection at startup. A pool closes after `idleMinutes` with no call in flight, and reopens on the next call. A name that rediscovery moves to another server gets a new pool; the old one closes once its calls finish. Discovery runs lazily, on the first call to a name that is not known yet and again on every `list_databases` call or call to an unknown name; a failed run keeps the previous result, and the error for an unknown name says which servers failed. In restricted mode the discovery query is checked and run read-only like any other. A discovered database whose name contains a character a connection URL cannot carry (such as `/`, `?`, `#`, `&` or `=`) is listed as an error and cannot be used.

## Transports

| Transport       | Flags                                                                       | Endpoint                                    |
| --------------- | --------------------------------------------------------------------------- | ------------------------------------------- |
| stdio (default) | `--transport=stdio`                                                         | standard input and output                   |
| SSE             | `--transport=sse --sse-host --sse-port`                                     | `/sse` (messages are posted to `/messages`) |
| Streamable HTTP | `--transport=streamable-http --streamable-http-host --streamable-http-port` | `/mcp`                                      |

The SSE and streamable HTTP transports let several MCP clients share one server. For example:

```bash
MCP_APP_DATABASE_URI=postgresql://username:password@localhost:5432/dbname \
  npx -y @zaggino/postgres-mcp --database=app --access-mode=unrestricted --transport=streamable-http
```

Then point the client at it. In Claude Code's `.mcp.json`:

```json
{
  "mcpServers": {
    "postgres": {
      "type": "http",
      "url": "http://localhost:8000/mcp"
    }
  }
}
```

In Codex's `~/.codex/config.toml`:

```toml
[mcp_servers.postgres]
url = "http://localhost:8000/mcp"
```

For SSE, start the server with `--transport=sse` and in Claude Code use `"type": "sse"` with `http://localhost:8000/sse` as the URL.

The HTTP transports check every request on every MCP endpoint (`/mcp`, `/sse` and `/messages`) and answer 403 when it fails:

- `Host` must be on the allow-list. On a loopback bind (`localhost`, `127.0.0.1`, `::1`) that is those three names with the bound port plus whatever `--allowed-hosts` adds. On any other bind it is `--allowed-hosts` alone, and the server refuses to start without it; pass `--allowed-hosts='*'` to accept any Host (`*` cannot be mixed with other entries). An entry without a port matches that hostname on any port; matching ignores case. Entries are checked at startup: no scheme or path, and IPv6 addresses in brackets (`[::1]:8000`).
- `Origin`, when the request has one, must be on the allow-list: `http://localhost:<port>`, `http://127.0.0.1:<port>` and `http://[::1]:<port>` on a loopback bind, plus whatever `--allowed-origins` adds; on any other bind `--allowed-origins` alone. `--allowed-origins='*'` accepts any Origin. Each entry must be exactly `scheme://host[:port]`, with no path or trailing slash. Requests without an `Origin` header (non-browser clients) are not checked.

A 403 is sent as `text/plain` with `X-Content-Type-Options: nosniff`.

Each HTTP transport holds at most `--max-sessions` sessions (default 100) and answers 503 `Too many sessions` to a new streamable HTTP `initialize` or a new `GET /sse` beyond that. A session with no request for `--session-idle-minutes` (default 30, `0` never) is closed, and its id then gets 404. On streamable HTTP the timer does not run while a request for the session is in flight, and starts afresh when the last one ends: a tool call longer than the idle time keeps its session, and so does an open `GET` stream, so a listening client is not closed. On SSE each `POST /messages` restarts the timer, but the result of a tool call travels over the `GET /sse` stream, which does not hold the session: a tool call longer than the idle time with no other message can still lose its session. The session cap bounds memory; it is not a security control, since anyone who passes the `Host` check can occupy the sessions.

There is no authentication. A server bound to a non-loopback address logs a warning at startup saying so; put it behind something that authenticates.

## CLI reference

```
postgres-mcp [options] (--database NAME ... | --config FILE)
```

| Option                   | Default       | Description                                                                                                                      |
| ------------------------ | ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `--database`             | none          | Database to serve; repeatable. URI from `MCP_<NAME>_DATABASE_URI`. Exclusive with `--config`.                                    |
| `--config`               | none          | JSONC [config file](#config-file). Exclusive with `--database`.                                                                  |
| `--idle-minutes`         | `10`          | Close a database's pool after this many idle minutes; `0` never closes; max 35791.                                               |
| `--statement-timeout`    | `30` / `0`    | Seconds after which Postgres cancels a statement: `30` in restricted mode, `0` (none) in unrestricted mode; max 2147483.         |
| `--access-mode`          | `restricted`  | `unrestricted` or `restricted`.                                                                                                  |
| `--transport`            | `stdio`       | `stdio`, `sse` or `streamable-http`.                                                                                             |
| `--sse-host`             | `localhost`   | Host to bind the SSE server to.                                                                                                  |
| `--sse-port`             | `8000`        | Port of the SSE server.                                                                                                          |
| `--streamable-http-host` | `localhost`   | Host to bind the streamable HTTP server to.                                                                                      |
| `--streamable-http-port` | `8000`        | Port of the streamable HTTP server.                                                                                              |
| `--allowed-hosts`        | loopback only | Comma-separated `Host` values to accept, added to loopback on a loopback bind; required on a non-loopback bind; `*` accepts any. |
| `--allowed-origins`      | loopback only | Comma-separated `Origin` values (`scheme://host[:port]`) to accept, added to loopback on a loopback bind; `*` accepts any.       |
| `--max-sessions`         | `100`         | Most concurrent HTTP sessions; further ones get 503.                                                                             |
| `--session-idle-minutes` | `30`          | Close an HTTP session after this many minutes without a request; `0` never; max 35791.                                           |
| `-h`, `--help`           |               | Show help.                                                                                                                       |

Environment variables:

| Variable                              | Description                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `MCP_<NAME>_DATABASE_URI`             | Connection URL of the database given with `--database=<name>` (name uppercased, `-` becomes `_`).            |
| `POSTGRES_MCP_INCLUDE_LANGFUSE_TRACE` | Set to `false` to leave the `_langfuse_trace` field out of index recommendation results. Defaults to `true`. |

## Postgres extension installation (optional)

Index tuning and workload analysis need the `pg_stat_statements` and `hypopg` extensions on your database.

- `pg_stat_statements` records query execution statistics, which lets the server find slow or resource-heavy queries.
- `hypopg` lets the server simulate the Postgres query planner after adding indexes.

### Cloud-managed Postgres (AWS RDS, Azure, Google Cloud SQL)

Both extensions are normally available already. Run `CREATE EXTENSION` with a sufficiently privileged role:

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE EXTENSION IF NOT EXISTS hypopg;
```

### Self-managed Postgres

Before creating `pg_stat_statements`, list it in `shared_preload_libraries` in the Postgres configuration file. `hypopg` does not ship with Postgres, so you may need to install it with your package manager first. `tests/Dockerfile.postgres-hypopg` shows one way to build an image that has it.

## Usage examples

Check database health:

> Check the health of my database and identify any issues.

Analyze slow queries:

> What are the slowest queries in my database? And how can I speed them up?

Get recommendations:

> My app is slow. How can I make it faster?

Generate index recommendations:

> Analyze my database workload and suggest indexes to improve performance.

Optimize a specific query:

> Help me optimize this query: SELECT \* FROM orders JOIN customers ON orders.customer_id = customers.id WHERE orders.created_at > '2023-01-01';

## MCP server API

The server provides its functionality through [MCP tools](https://modelcontextprotocol.io/docs/concepts/tools) only, because tool support is widespread across the [MCP client ecosystem](https://modelcontextprotocol.io/clients). Some other Postgres MCP servers, such as the [reference Postgres MCP server](https://github.com/modelcontextprotocol/servers-archived/tree/main/src/postgres), expose schema information as [MCP resources](https://modelcontextprotocol.io/docs/concepts/resources).

Every tool except `list_databases` and `cancel_query` takes a required `database` argument, the name of the database to run against.

| Tool name                  | Description                                                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `list_databases`           | Lists the databases the server can reach with their connection state, and the servers it discovers databases on.                          |
| `list_schemas`             | Lists all schemas in the database.                                                                                                        |
| `list_objects`             | Lists objects (tables, views, sequences, extensions) in a schema.                                                                         |
| `get_object_details`       | Shows details of one object, for example a table's columns, constraints and indexes.                                                      |
| `execute_sql`              | Executes SQL. In restricted mode only read-only statements are accepted.                                                                  |
| `explain_query`            | Gets the execution plan for a query and its cost estimates. Accepts hypothetical indexes to simulate the plan after adding them.          |
| `get_top_queries`          | Reports the slowest or most resource-intensive queries using `pg_stat_statements`. `sort_by` is `total_time`, `mean_time` or `resources`. |
| `analyze_workload_indexes` | Analyzes the workload for resource-intensive queries and recommends indexes.                                                              |
| `analyze_query_indexes`    | Analyzes a list of up to 10 SQL queries and recommends indexes.                                                                           |
| `analyze_db_health`        | Runs health checks: index, connection, constraint, buffer cache, sequence, vacuum, and replication health.                                |
| `cancel_query`             | Unrestricted mode only. Lists this session's running tool calls, or cancels one by `call_id`.                                             |

## Related projects

- [Postgres MCP Pro](https://github.com/crystaldba/postgres-mcp). The original Python server by Crystal DBA that this project is a TypeScript fork of.
- [PgHero](https://github.com/ankane/pghero). A performance dashboard for Postgres. The health checks here are adapted from it.
- [Dexter](https://github.com/ankane/dexter). An automatic indexer for Postgres that also tests hypothetical indexes.

## Frequently asked questions

_What Postgres versions are supported?_
The integration tests run against Postgres 12, 15 and 16. SQL is parsed with the PostgreSQL 18 grammar, so restricted mode accepts syntax up to that version.

_Who created this project?_
This is a TypeScript fork maintained by Martin Zagora. The original project was created by [Crystal DBA](https://www.crystaldba.ai).

## Issues and contributions

Open an [issue](https://github.com/zaggino/postgres-mcp/issues) or a [pull request](https://github.com/zaggino/postgres-mcp/pulls). Known follow-ups are listed in [docs/TODO.md](docs/TODO.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

`pnpm install` installs git hooks (`lefthook.yml`) that check formatting and lint on commit and run the typecheck and build on push.

## Technical notes

This section describes the technical considerations behind the design.

### Index tuning

Missing indexes are one of the most common causes of database performance problems. Indexes let Postgres locate data quickly. On small tables they make little difference, but as data grows the gap between a table scan and an index lookup becomes significant (typically _O_(_n_) vs _O_(_log_ _n_), more if joins on multiple tables are involved).

Index recommendations are generated in several stages:

1. _Identify SQL queries in need of tuning_.
   If you know a specific query is slow you can provide it. The server can also analyze the workload to find tuning targets, using the `pg_stat_statements` extension, which records the runtime and resource consumption of each query.

   A query is a candidate if it is a top resource consumer, either per execution or in aggregate. Execution time is used as a proxy for cumulative resource consumption. `analyze_workload_indexes` focuses on slow queries, using the mean time per execution with thresholds for execution count and mean execution time. Agents may also call `get_top_queries`, which accepts a parameter for mean vs. total execution time, then pass those queries to `analyze_query_indexes`.

   Index tuning systems often use "workload compression" to produce a representative subset of queries. This server does a limited form of it by normalizing queries so that those generated from the same template appear as one. Each query is weighted equally, a simplification that works when the benefits of indexing are large.

2. _Generate candidate indexes_.
   The SQL is parsed and columns used in filters, joins, grouping or sorting are identified.

   All possible indexes would need combinations of these columns, because Postgres supports [multicolumn indexes](https://www.postgresql.org/docs/current/indexes-multicolumn.html). The present implementation includes only one permutation of each multicolumn index to reduce the search space, because permutations often have equivalent performance.

3. _Search for the optimal index configuration_.
   The goal is the combination of indexes that best balances performance benefit against the cost of storing and maintaining them. The performance improvement is estimated with the "what if?" capabilities of the `hypopg` extension, which simulates how the Postgres optimizer would execute a query after the indexes are added, using the actual Postgres cost model.

   Planning a query generally needs the parameter values used in it, but query normalization removes constants and bind variables are not available. To address this, the server produces realistic constants by sampling table statistics. Postgres 16 added [generic explain plans](https://www.postgresql.org/docs/current/sql-explain.html), but they have limitations, for example around `LIKE` clauses.

   Search strategy matters because evaluating all index combinations is feasible only in simple situations. Adapting Microsoft's Anytime algorithm, the server uses a greedy search: find the best one-index solution, then the best index to add to it for a two-index solution, and so on. The search ends when the time budget is used up or a round fails to produce gains above the minimum improvement threshold of 10%.

4. _Cost-benefit analysis_.
   When one alternative performs better and another needs less space, the choice is framed as selecting a point along the [Pareto front](https://en.wikipedia.org/wiki/Pareto_front). The server takes a storage budget (`max_index_size_mb`), and also compares changes in relative terms: by default the change in the log (base 10) of the performance improvement must be 2x the difference in the log of the space cost. That allows a 10x increase in space for a 100x performance improvement.

The implementation is most closely related to the [Anytime Algorithm](https://www.microsoft.com/en-us/research/wp-content/uploads/2020/06/Anytime-Algorithm-of-Database-Tuning-Advisor-for-Microsoft-SQL-Server.pdf) in Microsoft SQL Server. Compared with [Dexter](https://github.com/ankane/dexter), it searches a larger space and uses different heuristics, which gives better solutions at the cost of longer runtime.

The result shows the work done in each round of the search, including a comparison of the query plans before and after each index. This gives the LLM context for responding to the recommendations.

### Database health

Health checks identify tuning opportunities and maintenance needs before they become critical. They are adapted from [PgHero](https://github.com/ankane/pghero).

- _Index health_. Looks for unused indexes, duplicate indexes, and bloated indexes. Autovacuum marks index entries that point to dead tuples as reusable but does not compact index pages, so eventually pages may contain few live references.
- _Buffer cache hit rate_. Measures the proportion of reads served from the buffer cache instead of disk. A low rate often means degraded application performance.
- _Connection health_. Checks the number of connections and their utilization. The biggest risk is running out of connections, but many idle or blocked connections can also indicate problems.
- _Vacuum health_. Vacuum prevents transaction id wraparound, which can make the database stop accepting writes. Postgres uses 32-bit transaction ids, so after about 2 billion transactions it must reuse them. To do that it "freezes" old records, replacing their transaction ids with a special value that means distant past. This check looks for tables that need vacuuming to prevent wraparound.
- _Replication health_. Monitors lag between primary and replicas, replication status, and replication slot usage.
- _Constraint health_. Postgres rejects transactions that would violate a constraint, but invalid constraints can appear after loading data or in recovery scenarios. This check looks for invalid constraints.
- _Sequence health_. Looks for sequences at risk of exceeding their maximum value.

### Postgres client library

The server connects with [node-postgres](https://node-postgres.com/) (`pg`). SQL is parsed with [`libpg-query`](https://github.com/launchql/libpg-query-node), which wraps the actual PostgreSQL parser.

### Protected SQL execution

AI amplifies the long-standing challenge of protecting databases from mistakes and attacks. Restricted mode focuses on integrity: preventing LLM-generated SQL from modifying or deleting data or changing the schema outside of your change management process.

The simplest way to guarantee read-only SQL is a database user with read-only permissions. Many find that cumbersome, so restricted mode enforces read-only execution on a read-write connection. Every statement runs inside `BEGIN TRANSACTION READ ONLY`. That alone can be circumvented, for example by issuing `ROLLBACK` and then starting a new transaction:

```sql
ROLLBACK; DROP TABLE users;
```

To prevent this the SQL is parsed before execution with `libpg-query`, and anything that is not on an allowlist of statement types, parse tree nodes, functions and extensions is rejected. That includes `COMMIT` and `ROLLBACK`. The common stored procedure languages, including PL/pgSQL and PL/Python, do not allow `COMMIT` or `ROLLBACK` inside functions, but if you have unsafe procedural languages enabled, the read-only protection could be circumvented.

Restricted mode also limits each statement to 30 seconds by default (`--statement-timeout`). Postgres enforces the limit and cancels the statement.

The two modes sit at opposite ends of the convenience and safety spectrum:

- "Unrestricted" gives maximum flexibility for development environments where speed matters and there is no valuable or sensitive data.
- "Restricted" is conservative, erring on the side of safety even when that is inconvenient. It is meant for databases exposed to untrusted users. For databases holding valuable or sensitive data, also use a database role with limited permissions.

## Development

Requirements: Node.js 26+ and pnpm 12. Clone and build as shown in [Run the server](#run-the-server).

| Command                 | Purpose                                                  |
| ----------------------- | -------------------------------------------------------- |
| `pnpm build`            | Build to `dist/`.                                        |
| `pnpm check`            | Lint and format check (Ultracite: oxlint and oxfmt).     |
| `pnpm fix`              | Apply lint and format fixes.                             |
| `pnpm typecheck`        | Type check with `tsc`.                                   |
| `pnpm test:unit`        | Unit tests.                                              |
| `pnpm test:integration` | Integration tests against real databases (needs Docker). |

The integration tests start Postgres 12, 15 and 16 in containers. Set `PG_VERSIONS=16` to run a single version, and `REQUIRE_DOCKER=1` to fail instead of skip when Docker is missing.

## License

MIT. See [LICENSE](LICENSE).
