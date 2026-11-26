# Security policy

## Supported versions

Only the latest release of [`@zaggino/postgres-mcp`](https://www.npmjs.com/package/@zaggino/postgres-mcp) receives security fixes.

## Reporting a vulnerability

Report vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/zaggino/postgres-mcp/security/advisories/new). Do not open a public issue, pull request or discussion for them.

Include the version, the access mode and transport the server ran with, the Postgres version, and the steps or SQL that reproduce the problem.

This project is maintained by one person in their spare time. Reports are acknowledged and handled on a best-effort basis; a confirmed issue is fixed in a new release and disclosed through a GitHub security advisory.

## Scope

In scope, for example:

- SQL that restricted mode accepts and that modifies data or schema, leaves the read-only transaction, or runs a function or statement type outside its allowlists.
- SQL injection through tool parameters or the queries the server builds internally.
- An HTTP transport bound to a loopback address accepting a request with a foreign `Host` header.
- Credentials leaking into tool results or logs.

Out of scope:

- Anything possible in unrestricted mode, which gives full read/write access by design.
- HTTP transports bound to a non-loopback address, which have no authentication or Host checks by design (see the README).
- Behaviour that depends on the database user having more privileges than it needs.
