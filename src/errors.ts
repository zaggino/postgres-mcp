export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A failure the caller can act on, such as an invalid argument, a missing prerequisite or an unusable database: tools
 * return it with isError and do not log it as a server error.
 */
export class UsageError extends Error {}
