import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { ErrorResult } from '../artifacts.ts';
import { errorMessage } from '../errors.ts';
import { isStatementError } from '../sql/sql-driver.ts';

/**
 * Tool output as JSON. A bigint is written as an exact JSON number; NaN and the infinities, which JSON has no number
 * for, as the strings "NaN", "Infinity" and "-Infinity". Raw JSON values (see parseJsonLossless) pass through.
 */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') {
      return JSON.rawJSON(item.toString());
    }
    return typeof item === 'number' && !Number.isFinite(item) ? String(item) : item;
  });
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
