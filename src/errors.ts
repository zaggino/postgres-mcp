export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A failure the caller can fix, an invalid argument or a missing prerequisite: returned with isError, not logged. */
export class UsageError extends Error {}
