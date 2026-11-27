import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** Builds one MCP server; a transport calls it once per session. */
export type ServerFactory = () => McpServer;
