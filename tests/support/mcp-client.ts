import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

/** Connects an in-memory MCP client to the server. */
export async function connectClient(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

/** The text of the single content item a tool call returned. */
export async function callToolText(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const { content } = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
  if (content.length !== 1) {
    throw new Error(`Expected one content item, got ${content.length}`);
  }
  const [item] = content;
  if (item?.type !== 'text') {
    throw new Error('Expected a text content item');
  }
  return item.text;
}
