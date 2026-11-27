import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { ErrorResult } from '../artifacts.ts';
import { errorMessage } from '../errors.ts';
import { isStatementError } from '../sql/sql-driver.ts';

export function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item));
}

export function formatTextResponse(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

/**
 * Upstream's `Error: ...` text. A failure Postgres raised for the statement keeps upstream's plain result; any other
 * failure (configuration, connection including a FATAL report, restricted-mode rejection, timeout, argument check,
 * internal) sets `isError`.
 */
export function formatError(error: unknown): CallToolResult {
  const [message, cause] = error instanceof ErrorResult ? [error.toText(), error.cause] : [errorMessage(error), error];
  const result = formatTextResponse(`Error: ${message}`);
  return isStatementError(cause) ? result : { ...result, isError: true };
}
