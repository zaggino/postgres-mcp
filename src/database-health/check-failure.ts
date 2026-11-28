import { CellError } from '../sql/cells.ts';
import { QueryValidationError } from '../sql/safe-sql.ts';
import { QueryTimeoutError, isStatementError } from '../sql/sql-driver.ts';

/** True for a failure that belongs to one check; connection-wide failures would repeat for every check. */
export function isCheckLocalFailure(error: unknown): boolean {
  return (
    error instanceof CellError ||
    error instanceof QueryTimeoutError ||
    error instanceof QueryValidationError ||
    isStatementError(error)
  );
}
