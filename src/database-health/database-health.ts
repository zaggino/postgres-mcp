import { errorMessage } from '../errors.ts';
import { log, logLine } from '../log.ts';
import type { SqlExecutor } from '../sql/safe-sql.ts';
import { QueryCancelledError } from '../sql/sql-driver.ts';
import { BufferHealthCalc } from './buffer-health-calc.ts';
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

/**
 * One line of the report. A failing check reports its error on its own line so the other checks still run; a
 * cancelled call stops the whole report.
 */
async function section(label: string, run: () => Promise<string>): Promise<string> {
  try {
    return `${label}: ${await run()}\n`;
  } catch (error) {
    if (error instanceof QueryCancelledError) {
      throw error;
    }
    const message = errorMessage(error);
    log('ERROR', `Health check "${label}" failed: ${message}`);
    return `${label}: Error: ${message}\n`;
  }
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
   * sequence, replication, buffer, constraint, all.
   */
  async health(healthType: string): Promise<string> {
    try {
      const requested = healthType.split(',').map((x) => x.trim());
      const healthTypes = new Set<HealthType>();
      for (const type of requested) {
        if (!isHealthType(type)) {
          return (
            `Invalid health types provided: '${healthType}'. ` +
            `Valid values are: ${HEALTH_TYPES.toSorted().join(', ')}. ` +
            'Please try again with a comma-separated list of valid health types.'
          );
        }
        healthTypes.add(type);
      }

      if (healthTypes.has('all')) {
        for (const type of HEALTH_TYPES) {
          if (type !== 'all') {
            healthTypes.add(type);
          }
        }
      }

      let result = '';

      if (healthTypes.has('index')) {
        const indexHealth = new IndexHealthCalc(this.sqlDriver);
        result += await section('Invalid index check', () => indexHealth.invalidIndexCheck());
        result += await section('Duplicate index check', () => indexHealth.duplicateIndexCheck());
        result += await section('Index bloat', () => indexHealth.indexBloat());
        result += await section('Unused index check', () => indexHealth.unusedIndexes());
      }

      if (healthTypes.has('connection')) {
        const connectionHealth = new ConnectionHealthCalc(this.sqlDriver);
        result += await section('Connection health', () => connectionHealth.connectionHealthCheck());
      }

      if (healthTypes.has('vacuum')) {
        const vacuumHealth = new VacuumHealthCalc(this.sqlDriver);
        result += await section('Vacuum health', () => vacuumHealth.transactionIdDangerCheck());
      }

      if (healthTypes.has('sequence')) {
        const sequenceHealth = new SequenceHealthCalc(this.sqlDriver);
        result += await section('Sequence health', () => sequenceHealth.sequenceDangerCheck());
      }

      if (healthTypes.has('replication')) {
        const replicationHealth = new ReplicationCalc(this.sqlDriver);
        result += await section('Replication health', () => replicationHealth.replicationHealthCheck());
      }

      if (healthTypes.has('buffer')) {
        const bufferHealth = new BufferHealthCalc(this.sqlDriver);
        result += await section('Buffer health for indexes', () => bufferHealth.indexHitRate());
        result += await section('Buffer health for tables', () => bufferHealth.tableHitRate());
      }

      if (healthTypes.has('constraint')) {
        const constraintHealth = new ConstraintHealthCalc(this.sqlDriver);
        result += await section('Constraint health', () => constraintHealth.invalidConstraintsCheck());
      }

      return result || 'No health checks were performed.';
    } catch (error) {
      const message = errorMessage(error);
      logLine(`Error calculating database health: ${message}`);
      return `Error calculating database health: ${message}`;
    }
  }
}
