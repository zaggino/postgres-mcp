import packageJson from '../package.json' with { type: 'json' };
import type { DatabaseRegistry } from './database-registry.ts';
import { AccessMode } from './sql/driver-factory.ts';

function accessModeClause({ accessMode, statementTimeoutSeconds: seconds }: DatabaseRegistry): string {
  if (accessMode === AccessMode.RESTRICTED) {
    return seconds > 0
      ? `Access mode is restricted: read-only, and Postgres cancels each statement after ${seconds} s.`
      : 'Access mode is restricted: read-only, with no statement timeout.';
  }
  return seconds > 0
    ? `Access mode is unrestricted: statements can write, and Postgres cancels each statement after ${seconds} s.`
    : 'Access mode is unrestricted: statements can write and have no timeout.';
}

/** Whether the cancel_query tool is registered; it is only in unrestricted mode. */
export function offersCancelQuery(registry: DatabaseRegistry): boolean {
  return registry.accessMode === AccessMode.UNRESTRICTED;
}

/** Sent to every client at initialization; each clause costs tokens in every session, so keep them short. */
export function serverInstructions(registry: DatabaseRegistry): string {
  const { explicit, serverCount, prefixed } = registry.describe();
  const clauses = [
    offersCancelQuery(registry)
      ? 'Every tool except list_databases and cancel_query requires a "database" argument.'
      : 'Every tool except list_databases requires a "database" argument.',
    explicit.length > 0 ? `Configured databases: ${explicit.join(', ')}.` : '',
    serverCount > 0
      ? `More databases are discovered on ${serverCount} server(s); call list_databases to see them all.`
      : "Call list_databases to see each database's connection state.",
    prefixed ? "Discovered names carry their server's prefix; inside the database the name is unprefixed." : '',
    accessModeClause(registry),
    'Cancelling a call cancels its running statement.',
    offersCancelQuery(registry) ? 'Call cancel_query to list running calls or cancel one by call_id.' : '',
    'An "Error:" result without isError is Postgres rejecting the statement; with isError the SQL got no answer from Postgres (restricted-mode refusal, invalid argument, missing extension or ANALYZE, connection, configuration or server failure). The index advisor tools set isError on every failure.',
    'analyze_db_health reports a failing check on its own line and still runs the others.',
    // oxlint-disable-next-line eslint/no-template-curly-in-string -- the literal ${VAR} names the config syntax
    'On a failure, show the user the error first, then check likely causes: an unset ${VAR}, wrong credentials, an unreachable host, or missing grants (which also empty the listing tools). list_databases shows the last connection error of each database.',
    `Report any problem with this MCP server to the user (bugs, confusing output, missing tools or arguments) and suggest an issue at ${packageJson.bugs.url}.`,
  ];
  return clauses.filter((clause) => clause !== '').join(' ');
}
