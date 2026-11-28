# Security policy

## Supported versions

Only the latest release of [`@zaggino/postgres-mcp`](https://www.npmjs.com/package/@zaggino/postgres-mcp) receives security fixes.

## Reporting a vulnerability

Report vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/zaggino/postgres-mcp/security/advisories/new). Do not open a public issue, pull request or discussion for them.

Include the version, the access mode and transport the server ran with, the Postgres version, and the steps or SQL that reproduce the problem.

This project is maintained by one person in their spare time. Reports are acknowledged and handled on a best-effort basis; a confirmed issue is fixed in a new release and disclosed through a GitHub security advisory.

## Scope

In scope, for example:

- SQL that restricted mode accepts and that modifies data or schema, leaves the read-only transaction, or runs a function or statement type outside its allowlists, including on a connection whose database user can write.
- SQL injection through tool parameters or the queries the server builds internally.
- A bypass of the `Host` header check on the HTTP transport bound to a loopback address (see the README's Transports section).
- Credentials leaking into tool results or logs, in either access mode.

Out of scope:

- Running arbitrary SQL in unrestricted mode, which gives full read/write access by design.
- The absence of authentication on the HTTP transport, and the absence of `Host` or `Origin` checks that `--allowed-hosts='*'` or `--allowed-origins='*'` turns off, which the README documents. A bypass of the configured checks is in scope.

Known weaknesses are tracked in [docs/TODO.md](docs/TODO.md); a report that adds a working exploit for one of them is still welcome through the private channel.
