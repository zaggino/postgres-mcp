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

  expect(restricted).toContain('Access mode is restricted');
  expect(unrestricted).toContain('Access mode is unrestricted');
  expect(restricted).toContain(ISSUES_URL);
  expect(unrestricted).toContain(ISSUES_URL);
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
