import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import type { ServerFactory } from '../server.ts';

export async function runStdio(createMcpServer: ServerFactory, onClientGone: () => void): Promise<void> {
  const server = createMcpServer();
  let closing = false;
  const handleClientGone = () => {
    if (closing) {
      return;
    }
    closing = true;
    onClientGone();
  };
  // StdioServerTransport does not report stdin EOF through onclose.
  server.server.onclose = handleClientGone;
  process.stdin.once('end', handleClientGone);
  process.stdin.once('close', handleClientGone);
  await server.connect(new StdioServerTransport());
}
