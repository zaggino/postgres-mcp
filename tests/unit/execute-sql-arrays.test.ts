import { expect, it as test } from 'vitest';

import { createServer } from '../../src/server.ts';
import { decodeArrayColumns } from '../../src/sql/array-types.ts';
import { SafeSqlDriver } from '../../src/sql/safe-sql.ts';
import { fakeExecutor } from '../support/fake-executor.ts';
import { arrayRowsResult, noRowsResult, rowsResult } from '../support/fake-pool.ts';
import type { QueryHandler } from '../support/fake-pool.ts';
import { callToolText, connectClient } from '../support/mcp-client.ts';
import { createTestRegistry } from '../support/registry.ts';

// A type OID of an array pg has no parser for, and the OID of its element type (which has none either).
const ARRAY_OID = 99_999;
const ELEMENT_OID = 99_998;

const isLookup = (text: string) => text.includes('pg_catalog.pg_type');

function handlerWith(lookup: QueryHandler): QueryHandler {
  return (query) => {
    if (isLookup(query.text)) {
      return lookup(query);
    }
    return query.text.includes('vt_enum') ? [arrayRowsResult(['v'], [['{a,b}'], [null]], [ARRAY_OID])] : [noRowsResult];
  };
}

async function run(handler: QueryHandler) {
  const { registry, fakes } = createTestRegistry(['a'], { handler });
  const client = await connectClient(createServer(registry));
  const call = () =>
    callToolText(client, 'execute_sql', { database: 'a', sql: "SELECT ARRAY['a','b']::vt_enum[] AS v" });
  return { call, fakes };
}

test('execute_sql returns an array column pg cannot parse as a JSON array, and looks the type up once per pool', async () => {
  const { call, fakes } = await run(
    handlerWith(() => [rowsResult([{ oid: ARRAY_OID, element_oid: ELEMENT_OID, delimiter: ',' }])])
  );

  const first = await call();
  const second = await call();

  expect(JSON.parse(first)).toEqual([{ v: ['a', 'b'] }, { v: null }]);
  expect(second).toBe(first);
  expect(fakes.get('a')?.queries.filter((query) => isLookup(query.text))).toHaveLength(1);
});

test('execute_sql keeps the array text and still succeeds when the type lookup fails', async () => {
  const { call } = await run(
    handlerWith(() => {
      throw new Error('permission denied for table pg_type');
    })
  );

  expect(JSON.parse(await call())).toEqual([{ v: '{a,b}' }, { v: null }]);
});

test('the array type lookup passes restricted mode', async () => {
  const executor = fakeExecutor((query) =>
    isLookup(query) ? [{ oid: ARRAY_OID, element_oid: ELEMENT_OID, delimiter: ';' }] : undefined
  );
  const table = { columns: [{ name: 'v', typeOid: ARRAY_OID }], rows: [['{x;y}']] };

  const decoded = await decodeArrayColumns(new SafeSqlDriver(executor), table);

  expect(decoded.rows).toEqual([[['x', 'y']]]);
});
