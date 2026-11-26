<div align="center">

<img src="assets/postgres-mcp-pro.png" alt="Postgres MCP Pro Logo" width="600"/>

</div>

# postgres-mcp

[![npm version](https://img.shields.io/npm/v/@zaggino/postgres-mcp)](https://www.npmjs.com/package/@zaggino/postgres-mcp)
[![CI](https://github.com/zaggino/postgres-mcp/actions/workflows/build.yml/badge.svg)](https://github.com/zaggino/postgres-mcp/actions/workflows/build.yml)

A Postgres MCP server with index tuning, explain plans, health checks, and safe SQL execution.

> This is a fork of [crystaldba/postgres-mcp](https://github.com/crystaldba/postgres-mcp) (Postgres MCP Pro), rewritten in TypeScript and published on npm as [`@zaggino/postgres-mcp`](https://www.npmjs.com/package/@zaggino/postgres-mcp). Credit for the design, the index tuning approach and the original implementation goes to Crystal DBA.

Differences from upstream:

- TypeScript on Node.js 26+ instead of Python.
- Installed from npm. There is no Docker image and no PyPI package.
- Structured tool results are JSON instead of Python repr text.
- The experimental LLM index tuning method (`method="llm"`) is not included. `method` accepts only `"dta"`.
- Restricted mode runs statements in an enforced read-only transaction.
- HTTP transports bound to a loopback address reject requests with a foreign `Host` header.
- The SQL comment marker is `/* postgres-mcp */` and hypothetical index names start with `postgres_mcp_idx_`.

## Overview

Postgres MCP Pro is a Model Context Protocol (MCP) server for working with a Postgres database from an AI agent, from initial coding through testing and deployment to production tuning and maintenance.

Features:

- **Database health**: analyze index health, connection utilization, buffer cache, vacuum health, sequence limits, replication lag, and more.
- **Index tuning**: search for the best set of indexes for your workload with a greedy search adapted from an industrial index advisor.
- **Query plans**: review EXPLAIN plans and simulate the effect of hypothetical indexes.
- **Schema information**: list schemas, objects, and object details so the agent can write correct SQL.
- **Safe SQL execution**: configurable access control, including a read-only mode with SQL parsing, for both development and production.

The server supports the [stdio](https://modelcontextprotocol.io/docs/concepts/transports#standard-input%2Foutput-stdio), [SSE](https://modelcontextprotocol.io/docs/concepts/transports#server-sent-events-sse) and streamable HTTP transports.

For background on why the original project was built, see the [upstream launch blog post](https://www.crystaldba.ai/blog/post/announcing-postgres-mcp-server-pro).

## Demo

*From unusable to lightning fast.*

Upstream's demo generated a movie app with an AI assistant whose SQLAlchemy ORM code ran painfully slow. With Postgres MCP Pro and Cursor the agent fixed ORM queries, indexing and caching, repaired a broken page by exploring the data, and improved the top movies query.

See the video below or read the [play-by-play](examples/movie-app.md).

https://github.com/user-attachments/assets/24e05745-65e9-4998-b877-a368f1eadc13

## Quick Start

### Prerequisites

1. Access credentials for your database. You can check them with `psql` or a GUI tool such as [pgAdmin](https://www.pgadmin.org/).
2. Node.js 26 or higher.

### Run the server

The server takes a [Postgres connection URI](https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-CONNSTRING-URIS) either as a positional argument or in the `DATABASE_URI` environment variable. If both are set, `DATABASE_URI` wins.

```bash
npx -y @zaggino/postgres-mcp "postgresql://user:pass@host:5432/db" --access-mode=restricted
```

To run from source instead:

```bash
git clone https://github.com/zaggino/postgres-mcp.git
cd postgres-mcp
pnpm install && pnpm build
node dist/index.js "postgresql://user:pass@host:5432/db" --access-mode=restricted
```

### Configure your AI assistant

Add the server to the `mcpServers` section of your client's configuration. For Claude Desktop the file is:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%/Claude/claude_desktop_config.json`

You can also open it from the `Settings` menu in Claude Desktop.

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "@zaggino/postgres-mcp", "--access-mode=unrestricted"],
      "env": {
        "DATABASE_URI": "postgresql://username:password@localhost:5432/dbname"
      }
    }
  }
}
```

When running from source, use `"command": "node"` and `"args": ["/path/to/postgres-mcp/dist/index.js", "--access-mode=unrestricted"]`.

### Access modes

- **Unrestricted**: full read/write access to data and schema. Suitable for development.
- **Restricted**: SQL is parsed and checked against allowlists of statements, node types and functions, executed in a read-only transaction, and limited to 30 seconds of execution time. Suitable for production.

Select the mode with `--access-mode=restricted` or `--access-mode=unrestricted` (the default).

### Other MCP clients

Most MCP clients use a configuration file similar to Claude Desktop's.

- Cursor: from the Command Palette open `Cursor Settings`, then the `MCP` tab.
- Windsurf: from the Command Palette open `Open Windsurf Settings Page`.
- Goose: run `goose configure`, then select `Add Extension`.
- Qodo Gen: open the Chat panel, click `Connect more tools`, then `+ Add new MCP`.

## Transports

| Transport | Flags | Endpoint |
|-----------|-------|----------|
| stdio (default) | `--transport=stdio` | standard input and output |
| SSE | `--transport=sse --sse-host --sse-port` | `/sse` (messages are posted to `/messages`) |
| Streamable HTTP | `--transport=streamable-http --streamable-http-host --streamable-http-port` | `/mcp` |

The SSE and streamable HTTP transports let several MCP clients share one server. For example:

```bash
DATABASE_URI=postgresql://username:password@localhost:5432/dbname \
  npx -y @zaggino/postgres-mcp --access-mode=unrestricted --transport=sse
```

Then point the client at it. In Cursor's `mcp.json` or Cline's `cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "postgres": {
      "type": "sse",
      "url": "http://localhost:8000/sse"
    }
  }
}
```

For Windsurf, `mcp_config.json` uses `serverUrl`:

```json
{
  "mcpServers": {
    "postgres": {
      "type": "sse",
      "serverUrl": "http://localhost:8000/sse"
    }
  }
}
```

For streamable HTTP use `http://localhost:8000/mcp` as the URL.

When the server is bound to a loopback host (`localhost`, `127.0.0.1`, `::1`), it rejects requests whose `Host` header does not name that address and port, on every MCP endpoint (`/mcp`, `/sse` and `/messages`). Servers bound to other addresses do no Host or Origin checks and have no authentication, and log a warning at startup saying so; put them behind something that does.

## CLI reference

```
postgres-mcp [options] [database_url]
```

| Option | Default | Description |
|--------|---------|-------------|
| `database_url` | none | Database connection URL (positional). |
| `--access-mode` | `unrestricted` | `unrestricted` or `restricted`. |
| `--transport` | `stdio` | `stdio`, `sse` or `streamable-http`. |
| `--sse-host` | `localhost` | Host to bind the SSE server to. |
| `--sse-port` | `8000` | Port of the SSE server. |
| `--streamable-http-host` | `localhost` | Host to bind the streamable HTTP server to. |
| `--streamable-http-port` | `8000` | Port of the streamable HTTP server. |
| `-h`, `--help` | | Show help. |

Environment variables:

| Variable | Description |
|----------|-------------|
| `DATABASE_URI` | Database connection URL. Takes precedence over the positional argument. |
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

| Tool name | Description |
|-----------|-------------|
| `list_schemas` | Lists all schemas in the database. |
| `list_objects` | Lists objects (tables, views, sequences, extensions) in a schema. |
| `get_object_details` | Shows details of one object, for example a table's columns, constraints and indexes. |
| `execute_sql` | Executes SQL. In restricted mode only read-only statements are accepted. |
| `explain_query` | Gets the execution plan for a query and its cost estimates. Accepts hypothetical indexes to simulate the plan after adding them. |
| `get_top_queries` | Reports the slowest or most resource-intensive queries using `pg_stat_statements`. `sort_by` is `total_time`, `mean_time` or `resources`. |
| `analyze_workload_indexes` | Analyzes the workload for resource-intensive queries and recommends indexes. |
| `analyze_query_indexes` | Analyzes a list of up to 10 SQL queries and recommends indexes. |
| `analyze_db_health` | Runs health checks: index, connection, constraint, buffer cache, sequence, vacuum, and replication health. |

## Related projects

**Postgres MCP servers**
- [Query MCP](https://github.com/alexander-zuev/supabase-mcp-server). An MCP server for Supabase Postgres with a three-tier safety architecture and Supabase management API support.
- [PG-MCP](https://github.com/stuzero/pg-mcp-server). An MCP server for PostgreSQL with flexible connection options, explain plans, extension context, and more.
- [Reference PostgreSQL MCP Server](https://github.com/modelcontextprotocol/servers-archived/tree/main/src/postgres). Exposes schema information as MCP resources and executes read-only queries.
- [Supabase Postgres MCP Server](https://github.com/supabase-community/supabase-mcp). Supabase management features, maintained by the Supabase community.
- [Nile MCP Server](https://github.com/niledatabase/nile-mcp-server). Access to the management API of Nile's multi-tenant Postgres service.
- [Neon MCP Server](https://github.com/neondatabase-labs/mcp-server-neon). Access to the management API of Neon's serverless Postgres service.
- [Wren MCP Server](https://github.com/Canner/wren-engine). A semantic engine for business intelligence on Postgres and other databases.

**DBA tools (including commercial offerings)**
- [Aiven Database Optimizer](https://aiven.io/solutions/aiven-ai-database-optimizer). Workload analysis, query optimizations, and other performance improvements.
- [dba.ai](https://www.dba.ai/). An AI-powered database administration assistant that integrates with GitHub to resolve code issues.
- [pgAnalyze](https://pganalyze.com/). Monitoring and analytics for finding performance bottlenecks, optimizing queries, and alerting.
- [Postgres.ai](https://postgres.ai/). An interactive chat experience combining a Postgres knowledge base and GPT-4.
- [Xata Agent](https://github.com/xataio/agent). An open-source AI agent that monitors database health, diagnoses issues, and gives recommendations.

**Postgres utilities**
- [Dexter](https://github.com/DexterDB/dexter). A tool for generating and testing hypothetical indexes on PostgreSQL.
- [PgHero](https://github.com/ankane/pghero). A performance dashboard for Postgres, with recommendations. The health checks here are adapted from PgHero.
- [PgTune](https://github.com/le0pard/pgtune?tab=readme-ov-file). Heuristics for tuning Postgres configuration.

## Frequently asked questions

*How is this different from other Postgres MCP servers?*
Many MCP servers let an AI agent run queries against Postgres. This one also adds tools for understanding and improving performance. For example, it implements a version of the [Anytime Algorithm of Database Tuning Advisor for Microsoft SQL Server](https://www.microsoft.com/en-us/research/wp-content/uploads/2020/06/Anytime-Algorithm-of-Database-Tuning-Advisor-for-Microsoft-SQL-Server.pdf) for automatic index tuning. The health checks are deterministic queries rather than SQL the LLM writes on each run, and index recommendations are based on the planner's cost model through `hypopg` rather than guesses.

*Why are MCP tools needed when the LLM can reason and generate SQL?*
LLMs are good at ambiguity, reasoning and natural language. Compared with procedural code they can be slow, expensive and non-deterministic. For index tuning there are established algorithms, so the server pairs the LLM with those algorithms and other procedural tools.

*What Postgres versions are supported?*
The integration tests run against Postgres 12, 15 and 16.

*Who created this project?*
This is a TypeScript fork maintained by Martin Zagora. The original project was created by [Crystal DBA](https://www.crystaldba.ai).

## Issues and contributions

Open an [issue](https://github.com/zaggino/postgres-mcp/issues) or a [pull request](https://github.com/zaggino/postgres-mcp/pulls). Known follow-ups are listed in [docs/TODO.md](docs/TODO.md).

## Technical notes

This section describes the technical considerations behind the design.

### Index tuning

Missing indexes are one of the most common causes of database performance problems. Indexes let Postgres locate data quickly. On small tables they make little difference, but as data grows the gap between a table scan and an index lookup becomes significant (typically *O*(*n*) vs *O*(*log* *n*), more if joins on multiple tables are involved).

Index recommendations are generated in several stages:

1. *Identify SQL queries in need of tuning*.
    If you know a specific query is slow you can provide it. The server can also analyze the workload to find tuning targets, using the `pg_stat_statements` extension, which records the runtime and resource consumption of each query.

    A query is a candidate if it is a top resource consumer, either per execution or in aggregate. Execution time is used as a proxy for cumulative resource consumption. `analyze_workload_indexes` focuses on slow queries, using the mean time per execution with thresholds for execution count and mean execution time. Agents may also call `get_top_queries`, which accepts a parameter for mean vs. total execution time, then pass those queries to `analyze_query_indexes`.

    Index tuning systems often use "workload compression" to produce a representative subset of queries. This server does a limited form of it by normalizing queries so that those generated from the same template appear as one. Each query is weighted equally, a simplification that works when the benefits of indexing are large.

2. *Generate candidate indexes*.
    The SQL is parsed and columns used in filters, joins, grouping or sorting are identified.

    All possible indexes would need combinations of these columns, because Postgres supports [multicolumn indexes](https://www.postgresql.org/docs/current/indexes-multicolumn.html). The present implementation includes only one permutation of each multicolumn index to reduce the search space, because permutations often have equivalent performance.

3. *Search for the optimal index configuration*.
    The goal is the combination of indexes that best balances performance benefit against the cost of storing and maintaining them. The performance improvement is estimated with the "what if?" capabilities of the `hypopg` extension, which simulates how the Postgres optimizer would execute a query after the indexes are added, using the actual Postgres cost model.

    Planning a query generally needs the parameter values used in it, but query normalization removes constants and bind variables are not available. To address this, the server produces realistic constants by sampling table statistics. Postgres 16 added [generic explain plans](https://www.postgresql.org/docs/current/sql-explain.html), but they have limitations, for example around `LIKE` clauses.

    Search strategy matters because evaluating all index combinations is feasible only in simple situations. Adapting Microsoft's Anytime algorithm, the server uses a greedy search: find the best one-index solution, then the best index to add to it for a two-index solution, and so on. The search ends when the time budget is used up or a round fails to produce gains above the minimum improvement threshold of 10%.

4. *Cost-benefit analysis*.
    When one alternative performs better and another needs less space, the choice is framed as selecting a point along the [Pareto front](https://en.wikipedia.org/wiki/Pareto_front). The server takes a storage budget (`max_index_size_mb`), and also compares changes in relative terms: by default the change in the log (base 10) of the performance improvement must be 2x the difference in the log of the space cost. That allows a 10x increase in space for a 100x performance improvement.

The implementation is most closely related to the [Anytime Algorithm](https://www.microsoft.com/en-us/research/wp-content/uploads/2020/06/Anytime-Algorithm-of-Database-Tuning-Advisor-for-Microsoft-SQL-Server.pdf) in Microsoft SQL Server. Compared with [Dexter](https://github.com/ankane/dexter/), it searches a larger space and uses different heuristics, which gives better solutions at the cost of longer runtime.

The result shows the work done in each round of the search, including a comparison of the query plans before and after each index. This gives the LLM context for responding to the recommendations.

### Database health

Health checks identify tuning opportunities and maintenance needs before they become critical. They are adapted from [PgHero](https://github.com/ankane/pghero).

- *Index health*. Looks for unused indexes, duplicate indexes, and bloated indexes. Autovacuum marks index entries that point to dead tuples as reusable but does not compact index pages, so eventually pages may contain few live references.
- *Buffer cache hit rate*. Measures the proportion of reads served from the buffer cache instead of disk. A low rate often means degraded application performance.
- *Connection health*. Checks the number of connections and their utilization. The biggest risk is running out of connections, but many idle or blocked connections can also indicate problems.
- *Vacuum health*. Vacuum prevents transaction id wraparound, which can make the database stop accepting writes. Postgres uses 32-bit transaction ids, so after about 2 billion transactions it must reuse them. To do that it "freezes" old records, replacing their transaction ids with a special value that means distant past. This check looks for tables that need vacuuming to prevent wraparound.
- *Replication health*. Monitors lag between primary and replicas, replication status, and replication slot usage.
- *Constraint health*. Postgres rejects transactions that would violate a constraint, but invalid constraints can appear after loading data or in recovery scenarios. This check looks for invalid constraints.
- *Sequence health*. Looks for sequences at risk of exceeding their maximum value.

### Postgres client library

The server connects with [node-postgres](https://node-postgres.com/) (`pg`). SQL is parsed with [`libpg-query`](https://github.com/launchql/libpg-query-node), which wraps the actual PostgreSQL parser.

### Connection configuration

Like the [reference PostgreSQL MCP server](https://github.com/modelcontextprotocol/servers-archived/tree/main/src/postgres), this server takes the connection information at startup. That is convenient if you always use the same database, but cumbersome if you switch.

[PG-MCP](https://github.com/stuzero/pg-mcp-server) instead takes connection details in MCP tool calls. That is easier for switching databases and lets one server serve several users, but the credentials pass through the LLM and are stored in the chat history. Startup configuration has its own weakness: few MCP clients store server configuration securely.

### Schema information

The schema tools give the agent what it needs to generate correct and performant SQL. For example, for "How many flights took off from San Francisco and landed in Paris during the past year?" the agent must find the flights table, the origin and destination columns, and perhaps a table that maps airport codes to locations.

*Why provide schema tools when LLMs can query the Postgres system catalog directly?*
In upstream's experience Claude is very good at exploring the [system catalog](https://www.postgresql.org/docs/current/catalogs.html) and the [information schema](https://www.postgresql.org/docs/current/information-schema.html), but other LLMs may not be as reliable.

*Why tools and not [MCP resources](https://modelcontextprotocol.io/docs/concepts/resources)?*
Resource support is less widespread than tool support in MCP clients, and some clients only support human navigation of the resource tree, even though the standard allows agents to access resources.

### Protected SQL execution

AI amplifies the long-standing challenge of protecting databases from mistakes and attacks. Restricted mode focuses on integrity: preventing LLM-generated SQL from modifying or deleting data or changing the schema outside of your change management process.

The simplest way to guarantee read-only SQL is a database user with read-only permissions. Many find that cumbersome, so restricted mode enforces read-only execution on a read-write connection. Every statement runs inside `BEGIN TRANSACTION READ ONLY`. That alone can be circumvented, for example by issuing `ROLLBACK` and then starting a new transaction:

```sql
ROLLBACK; DROP TABLE users;
```

To prevent this the SQL is parsed before execution with `libpg-query`, and anything that is not on an allowlist of statement types, parse tree nodes, functions and extensions is rejected. That includes `COMMIT` and `ROLLBACK`. The common stored procedure languages, including PL/pgSQL and PL/Python, do not allow `COMMIT` or `ROLLBACK` inside functions, but if you have unsafe procedural languages enabled, the read-only protection could be circumvented.

Restricted mode also limits query execution time to 30 seconds. The limit is applied on the client side: the server stops waiting, but the statement can keep running on the database (see [docs/TODO.md](docs/TODO.md)).

The two modes sit at opposite ends of the convenience and safety spectrum:

- "Unrestricted" gives maximum flexibility for development environments where speed matters and there is no valuable or sensitive data. It matches [Cursor's auto-run mode](https://docs.cursor.com/chat/tools#auto-run), where the agent works with little human oversight.
- "Restricted" is conservative, erring on the side of safety even when that is inconvenient. It is meant for databases exposed to untrusted users. For databases holding valuable or sensitive data, also use a database role with limited permissions.

## Development

Requirements: Node.js 26+ and pnpm 11.

```bash
git clone https://github.com/zaggino/postgres-mcp.git
cd postgres-mcp
pnpm install
```

| Command | Purpose |
|---------|---------|
| `pnpm build` | Build to `dist/`. |
| `pnpm check` | Lint and format check (Ultracite/Biome). |
| `pnpm fix` | Apply lint and format fixes. |
| `pnpm typecheck` | Type check with `tsc`. |
| `pnpm test:unit` | Unit tests. |
| `pnpm test:integration` | Integration tests against real databases (needs Docker). |

The integration tests start Postgres 12, 15 and 16 in containers. Set `PG_VERSIONS=16` to run a single version, and `REQUIRE_DOCKER=1` to fail instead of skip when Docker is missing.

Run the server from source:

```bash
node dist/index.js "postgresql://user:password@localhost:5432/dbname"
```

## License

MIT. See [LICENSE](LICENSE).
