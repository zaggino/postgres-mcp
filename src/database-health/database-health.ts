import { errorMessage } from '../errors.ts';
import { log } from '../log.ts';
import type { SqlExecutor } from '../sql/safe-sql.ts';
import { BufferHealthCalc } from './buffer-health-calc.ts';
import { isCheckLocalFailure } from './check-failure.ts';
import { ConnectionHealthCalc } from './connection-health-calc.ts';
import { ConstraintHealthCalc } from './constraint-health-calc.ts';
import { IndexHealthCalc } from './index-health-calc.ts';
import { ReplicationCalc } from './replication-calc.ts';
import { SequenceHealthCalc } from './sequence-health-calc.ts';
import { VacuumHealthCalc } from './vacuum-health-calc.ts';

export const HEALTH_TYPES = [
  'index',
  'connection',
  'vacuum',
  'sequence',
  'replication',
  'buffer',
  'constraint',
  'all',
] as const;

export type HealthType = (typeof HEALTH_TYPES)[number];

function isHealthType(value: string): value is HealthType {
  return (HEALTH_TYPES as readonly string[]).includes(value);
}

interface HealthCheck {
  label: string;
  run: () => Promise<string>;
  type: Exclude<HealthType, 'all'>;
}

/**
 * One line of the report. A check-local failure is reported on the check's own line so the other checks still
 * run; any other failure (connection, cancellation) stops the whole report.
 */
async function section({ label, run }: HealthCheck): Promise<string> {
  try {
    return `${label}: ${await run()}\n`;
  } catch (error) {
    if (!isCheckLocalFailure(error)) {
      throw error;
    }
    const message = errorMessage(error);
    log('ERROR', `Health check "${label}" failed: ${message}`);
    return `${label}: Error: ${message}\n`;
  }
}

/** The checks in report order. The calcs that serve several checks are shared within one report. */
function healthChecks(sqlDriver: SqlExecutor): HealthCheck[] {
  const indexHealth = new IndexHealthCalc(sqlDriver);
  const bufferHealth = new BufferHealthCalc(sqlDriver);
  return [
    { type: 'index', label: 'Invalid index check', run: () => indexHealth.invalidIndexCheck() },
    { type: 'index', label: 'Duplicate index check', run: () => indexHealth.duplicateIndexCheck() },
    { type: 'index', label: 'Index bloat', run: () => indexHealth.indexBloat() },
    { type: 'index', label: 'Unused index check', run: () => indexHealth.unusedIndexes() },
    {
      type: 'connection',
      label: 'Connection health',
      run: () => new ConnectionHealthCalc(sqlDriver).connectionHealthCheck(),
    },
    { type: 'vacuum', label: 'Vacuum health', run: () => new VacuumHealthCalc(sqlDriver).transactionIdDangerCheck() },
    { type: 'sequence', label: 'Sequence health', run: () => new SequenceHealthCalc(sqlDriver).sequenceDangerCheck() },
    {
      type: 'replication',
      label: 'Replication health',
      run: () => new ReplicationCalc(sqlDriver).replicationHealthCheck(),
    },
    { type: 'buffer', label: 'Buffer health for indexes', run: () => bufferHealth.indexHitRate() },
    { type: 'buffer', label: 'Buffer health for tables', run: () => bufferHealth.tableHitRate() },
    {
      type: 'constraint',
      label: 'Constraint health',
      run: () => new ConstraintHealthCalc(sqlDriver).invalidConstraintsCheck(),
    },
  ];
}

export class DatabaseHealthTool {
  private readonly sqlDriver: SqlExecutor;

  constructor(sqlDriver: SqlExecutor) {
    this.sqlDriver = sqlDriver;
  }

  /**
   * Run database health checks for the specified components.
   *
   * `healthType` is a comma-separated list of: index, connection, vacuum,
   * sequence, replication, buffer, constraint, all. An invalid type, and a failure
   * that is not local to one check (connection, cancellation), are thrown.
   */
  async health(healthType: string): Promise<string> {
    const requested = healthType.split(',').map((x) => x.trim());
    const healthTypes = new Set<HealthType>();
    for (const type of requested) {
      if (!isHealthType(type)) {
        throw new Error(
          `Invalid health types provided: '${healthType}'. ` +
            `Valid values are: ${HEALTH_TYPES.toSorted().join(', ')}. ` +
            'Please try again with a comma-separated list of valid health types.'
        );
      }
      healthTypes.add(type);
    }

    const all = healthTypes.has('all');
    let result = '';
    for (const check of healthChecks(this.sqlDriver)) {
      if (all || healthTypes.has(check.type)) {
        result += await section(check);
      }
    }
    return result || 'No health checks were performed.';
  }
}
