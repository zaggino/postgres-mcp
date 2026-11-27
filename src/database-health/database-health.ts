import { errorMessage } from '../errors.ts';
import { logLine } from '../log.ts';
import type { SqlExecutor } from '../sql/safe-sql.ts';
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
        result += `Invalid index check: ${await indexHealth.invalidIndexCheck()}\n`;
        result += `Duplicate index check: ${await indexHealth.duplicateIndexCheck()}\n`;
        result += `Index bloat: ${await indexHealth.indexBloat()}\n`;
        result += `Unused index check: ${await indexHealth.unusedIndexes()}\n`;
      }

      if (healthTypes.has('connection')) {
        const connectionHealth = new ConnectionHealthCalc(this.sqlDriver);
        result += `Connection health: ${await connectionHealth.connectionHealthCheck()}\n`;
      }

      if (healthTypes.has('vacuum')) {
        const vacuumHealth = new VacuumHealthCalc(this.sqlDriver);
        result += `Vacuum health: ${await vacuumHealth.transactionIdDangerCheck()}\n`;
      }

      if (healthTypes.has('sequence')) {
        const sequenceHealth = new SequenceHealthCalc(this.sqlDriver);
        result += `Sequence health: ${await sequenceHealth.sequenceDangerCheck()}\n`;
      }

      if (healthTypes.has('replication')) {
        const replicationHealth = new ReplicationCalc(this.sqlDriver);
        result += `Replication health: ${await replicationHealth.replicationHealthCheck()}\n`;
      }

      if (healthTypes.has('buffer')) {
        const bufferHealth = new BufferHealthCalc(this.sqlDriver);
        result += `Buffer health for indexes: ${await bufferHealth.indexHitRate()}\n`;
        result += `Buffer health for tables: ${await bufferHealth.tableHitRate()}\n`;
      }

      if (healthTypes.has('constraint')) {
        const constraintHealth = new ConstraintHealthCalc(this.sqlDriver);
        result += `Constraint health: ${await constraintHealth.invalidConstraintsCheck()}\n`;
      }

      return result || 'No health checks were performed.';
    } catch (error) {
      const message = errorMessage(error);
      logLine(`Error calculating database health: ${message}`);
      return `Error calculating database health: ${message}`;
    }
  }
}
