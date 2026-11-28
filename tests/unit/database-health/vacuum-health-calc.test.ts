import { describe, expect, it } from 'vitest';

import { VacuumHealthCalc } from '../../../src/database-health/vacuum-health-calc.ts';
import { fakeExecutor } from '../../support/fake-executor.ts';

describe('transactionIdDangerCheck', () => {
  it('rejects a NULL transactions_left instead of reporting 0 transactions left', async () => {
    const calc = new VacuumHealthCalc(fakeExecutor(() => [{ schema: 'public', table: 't', transactions_left: null }]));

    await expect(calc.transactionIdDangerCheck()).rejects.toThrow('transactions_left');
  });
});
