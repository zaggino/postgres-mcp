# Changelog

## 1.0.0 (2026-11-28)


### ⚠ BREAKING CHANGES

* list_databases returns { cli?, config?, servers?: [{ server, prefix?, error?, databases }] } instead of { databases, servers }; an entry is a bare name or { database, state, idle_seconds_left?, error?, last_error? }, without source, and prefix is omitted when empty.
* the advisor's cost and multiple fields are numbers instead of text, index_estimated_size is replaced by index_size_bytes and total_size_bytes is a number, no recommendations returns an empty recommendations array instead of a sentence, unbounded improvements are null instead of the infinity sign, and a statement Postgres rejects during analysis now sets isError.
* get_top_queries without pg_stat_statements, and explain_query with hypothetical_indexes but without hypopg, now return the install guidance as an Error: result with isError instead of ordinary output.
* --transport=sse, --sse-host and --sse-port are removed, and the /sse and /messages endpoints are gone. Use --transport=streamable-http with --streamable-http-host/--streamable-http-port and the /mcp endpoint.
* execute_sql requires the sql argument; explain_query rejects hypothetical indexes that are not {table, columns: string[], using?} (a string columns value is no longer split into characters); analyze_query_indexes and analyze_workload_indexes omit _langfuse_trace unless POSTGRES_MCP_INCLUDE_LANGFUSE_TRACE=true.
* execute_sql output changes: date and time values are Postgres text instead of UTC ISO instants (no host time-zone shift, microseconds and infinity kept); bytea is hex text instead of a Buffer object; interval, point and circle are Postgres text instead of objects; int8 above 2^53 and int8[] elements are exact JSON numbers instead of strings; numeric[] elements are strings; float NaN and infinities are the strings "NaN", "Infinity" and "-Infinity" instead of null.
* without --access-mode or a config accessMode the server now runs in restricted (read-only) mode. Pass --access-mode=unrestricted to keep the previous behaviour.
* harden SQL error handling and the HTTP transports ([#8](https://github.com/zaggino/postgres-mcp/issues/8))
* DATABASE_URI and the positional database_url argument are removed, and every tool now requires a database argument.
* rewrite the server in typescript ([#1](https://github.com/zaggino/postgres-mcp/issues/1))

### Features

* accept comments and trailing commas in the config file ([#9](https://github.com/zaggino/postgres-mcp/issues/9)) ([899ae7f](https://github.com/zaggino/postgres-mcp/commit/899ae7f8c019eb41e17b5175ecca6675df3cf88b))
* cancel running statements and add a server-side statement timeout ([#14](https://github.com/zaggino/postgres-mcp/issues/14)) ([e98e876](https://github.com/zaggino/postgres-mcp/commit/e98e876fa5f30e4f01ca2e866ada30ba03d592db))
* default to restricted access mode ([#10](https://github.com/zaggino/postgres-mcp/issues/10)) ([550f4ff](https://github.com/zaggino/postgres-mcp/commit/550f4ffe2ef70b873ac787cfb9cf125da18cd4d7))
* flag health, top-queries and index advisor failures with isError ([#25](https://github.com/zaggino/postgres-mcp/issues/25)) ([b0872c2](https://github.com/zaggino/postgres-mcp/commit/b0872c2090d4570678a2c88272f22cd568c2f02e))
* flag server-side errors and extend the server instructions ([#13](https://github.com/zaggino/postgres-mcp/issues/13)) ([23534eb](https://github.com/zaggino/postgres-mcp/commit/23534eb2e3246f01bd6550060e9d4860ca50d40b))
* group list_databases output by source ([#27](https://github.com/zaggino/postgres-mcp/issues/27)) ([c64e35f](https://github.com/zaggino/postgres-mcp/commit/c64e35f03565c6cc1595e6f6a84e133fad8e6152))
* harden SQL error handling and the HTTP transports ([#8](https://github.com/zaggino/postgres-mcp/issues/8)) ([c8f802b](https://github.com/zaggino/postgres-mcp/commit/c8f802b95d260b70c761e0d4376b0a6e18e8fa65))
* remove the SSE transport ([#24](https://github.com/zaggino/postgres-mcp/issues/24)) ([477f255](https://github.com/zaggino/postgres-mcp/commit/477f2551b8ff4afca55496cb79d5a8ffc53df63d))
* require execute_sql sql, type hypothetical indexes and drop the advisor trace by default ([#23](https://github.com/zaggino/postgres-mcp/issues/23)) ([a211f44](https://github.com/zaggino/postgres-mcp/commit/a211f447a98ce7424b1e4e648c60d372100f7fca))
* return postgres values exactly as sent in tool output ([#22](https://github.com/zaggino/postgres-mcp/issues/22)) ([cbdc593](https://github.com/zaggino/postgres-mcp/commit/cbdc593deb0f239e96a250b261b9d6e158a5785e))
* return typed structured results from the index advisor ([#26](https://github.com/zaggino/postgres-mcp/issues/26)) ([bb00ea1](https://github.com/zaggino/postgres-mcp/commit/bb00ea19c50f2c83fd56166128c87c5f69dfda50))
* rewrite the server in typescript ([#1](https://github.com/zaggino/postgres-mcp/issues/1)) ([60191d0](https://github.com/zaggino/postgres-mcp/commit/60191d08e2000078f721f11c5f14c6f6b4899167))
* serve multiple databases from one server ([#7](https://github.com/zaggino/postgres-mcp/issues/7)) ([b5ba64b](https://github.com/zaggino/postgres-mcp/commit/b5ba64b2ff6ea08377ab2f06d7607d3baf88e91a))


### Bug Fixes

* **config:** default server uris to port 5432 and the postgres database ([#11](https://github.com/zaggino/postgres-mcp/issues/11)) ([0951408](https://github.com/zaggino/postgres-mcp/commit/095140884db57d1d6aa166fb9da77b1cbe20ffb9))
* decode query rows with strict cell readers and isolate health checks ([#21](https://github.com/zaggino/postgres-mcp/issues/21)) ([cebe91a](https://github.com/zaggino/postgres-mcp/commit/cebe91a3105a11d69a72d985b591a9b80a02f2e2))
* **sql:** only invalidate the pool on connection-level errors ([#16](https://github.com/zaggino/postgres-mcp/issues/16)) ([6256bad](https://github.com/zaggino/postgres-mcp/commit/6256baded9c85cc7eeb81b1464276cda289fd75e))
