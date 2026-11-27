import { expect, it as test } from 'vitest';

import { createServer } from '../../src/server.ts';
import { AccessMode } from '../../src/sql/driver-factory.ts';
import { connectClient } from '../support/mcp-client.ts';
import { createTestRegistry } from '../support/registry.ts';

const ISSUES_URL = 'https://github.com/zaggino/postgres-mcp/issues';

async function instructions(options: Parameters<typeof createTestRegistry>[1]) {
  const client = await connectClient(createServer(createTestRegistry(['app'], options).registry));
  return client.getInstructions() ?? '';
}

test('the instructions state the access mode in effect and where to report server issues', async () => {
  const restricted = await instructions({ accessMode: AccessMode.RESTRICTED });
  const unrestricted = await instructions({ accessMode: AccessMode.UNRESTRICTED });

  expect(restricted).toContain('Access mode is restricted: read-only, and Postgres cancels each statement after 30 s.');
  expect(unrestricted).toContain('Access mode is unrestricted: statements can write and have no timeout.');
  expect(restricted).toContain('Cancelling a call cancels its running statement.');
  expect(restricted).toContain(ISSUES_URL);
  expect(unrestricted).toContain(ISSUES_URL);
});

test('the instructions point to cancel_query only in unrestricted mode', async () => {
  const clause = 'Call cancel_query to list running calls or cancel one by call_id.';

  await expect(instructions({ accessMode: AccessMode.UNRESTRICTED })).resolves.toContain(clause);
  await expect(instructions({ accessMode: AccessMode.RESTRICTED })).resolves.not.toContain('cancel_query');
});

test('the instructions state a non-default statement timeout', async () => {
  await expect(instructions({ accessMode: AccessMode.UNRESTRICTED, statementTimeoutSeconds: 5 })).resolves.toContain(
    'statements can write, and Postgres cancels each statement after 5 s.'
  );
  await expect(instructions({ accessMode: AccessMode.RESTRICTED, statementTimeoutSeconds: 0 })).resolves.toContain(
    'read-only, with no statement timeout.'
  );
});

test('the instructions mention discovered-name prefixes only when a server has a prefix', async () => {
  const server = (prefix: string) => ({
    uri: { uri: 'postgresql://u:p@h/postgres' },
    prefix,
    include: ['*'],
    exclude: [],
  });

  await expect(instructions({ servers: [server('dev-')] })).resolves.toContain("carry their server's prefix");
  await expect(instructions({ servers: [server('')] })).resolves.not.toContain('prefix');
});
