import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { DatabaseRegistry } from '../../src/database-registry.ts';
import { createServer } from '../../src/server.ts';
import { AccessMode } from '../../src/sql/driver-factory.ts';
import { connectClient } from '../support/mcp-client.ts';
import { describeWithPostgres } from '../support/postgres.ts';

interface ValueCase {
  expr: string;
  /** Exact `execute_sql` output text. */
  expected: string;
  /** Lowest PostgreSQL major version that supports the expression. */
  minMajor?: number;
}

// Every statement runs after `SET TIME ZONE 'UTC'` (execute_sql returns the last result of a multi-statement string),
// so timestamptz output does not depend on the container's default zone.
const cases: ValueCase[] = [
  { expr: 'NULL::int', expected: '[{"v":null}]' },
  { expr: '123::int8', expected: '[{"v":123}]' },
  { expr: '9007199254740993::int8', expected: '[{"v":9007199254740993}]' },
  { expr: "'{9007199254740993,NULL}'::int8[]", expected: '[{"v":[9007199254740993,null]}]' },
  {
    expr: '1234567890.123456789012345678::numeric',
    expected: '[{"v":"1234567890.123456789012345678"}]',
  },
  {
    expr: "'{12345678901234567890.123456789,1.5}'::numeric[]",
    expected: '[{"v":["12345678901234567890.123456789","1.5"]}]',
  },
  { expr: "'NaN'::numeric", expected: '[{"v":"NaN"}]' },
  { expr: "'NaN'::float8", expected: '[{"v":"NaN"}]' },
  {
    expr: "ARRAY['NaN','Infinity','-Infinity',1.5]::float8[]",
    expected: '[{"v":["NaN","Infinity","-Infinity",1.5]}]',
  },
  { expr: "'$1234.50'::money", expected: '[{"v":"$1,234.50"}]' },
  { expr: '4294967295::oid', expected: '[{"v":4294967295}]' },
  { expr: "'9007199254740993'::xid8", expected: '[{"v":"9007199254740993"}]', minMajor: 13 },
  { expr: "'2024-02-29'::date", expected: '[{"v":"2024-02-29"}]' },
  { expr: "'infinity'::date", expected: '[{"v":"infinity"}]' },
  { expr: "'-infinity'::date", expected: '[{"v":"-infinity"}]' },
  { expr: "'0044-03-15 BC'::date", expected: '[{"v":"0044-03-15 BC"}]' },
  { expr: "'2024-02-29 13:14:15.123456'::timestamp", expected: '[{"v":"2024-02-29 13:14:15.123456"}]' },
  { expr: "'infinity'::timestamp", expected: '[{"v":"infinity"}]' },
  { expr: "'-infinity'::timestamp", expected: '[{"v":"-infinity"}]' },
  {
    expr: "'2024-02-29 13:14:15.123456+00'::timestamptz",
    expected: '[{"v":"2024-02-29 13:14:15.123456+00"}]',
  },
  { expr: "'infinity'::timestamptz", expected: '[{"v":"infinity"}]' },
  { expr: "'-infinity'::timestamptz", expected: '[{"v":"-infinity"}]' },
  { expr: "'13:14:15.123456'::time", expected: '[{"v":"13:14:15.123456"}]' },
  { expr: "'13:14:15.5+02'::timetz", expected: '[{"v":"13:14:15.5+02"}]' },
  {
    expr: "interval '1 year 2 mons 3 days 04:05:06.789'",
    expected: '[{"v":"1 year 2 mons 3 days 04:05:06.789"}]',
  },
  {
    expr: "ARRAY['2024-02-29','infinity']::date[]",
    expected: '[{"v":["2024-02-29","infinity"]}]',
  },
  {
    expr: "ARRAY['2024-02-29 13:14:15.123456']::timestamp[]",
    expected: '[{"v":["2024-02-29 13:14:15.123456"]}]',
  },
  {
    expr: "ARRAY['2024-02-29 13:14:15.123456+00']::timestamptz[]",
    expected: '[{"v":["2024-02-29 13:14:15.123456+00"]}]',
  },
  {
    expr: "ARRAY[interval '1 day', interval '2 hours']",
    expected: '[{"v":["1 day","02:00:00"]}]',
  },
  { expr: `'{"n": 9007199254740993}'::json`, expected: '[{"v":{"n":9007199254740993}}]' },
  { expr: `'{"n": 9007199254740993}'::jsonb`, expected: '[{"v":{"n":9007199254740993}}]' },
  { expr: `ARRAY['{"n": 9007199254740993}']::json[]`, expected: '[{"v":[{"n":9007199254740993}]}]' },
  {
    expr: `ARRAY['{"n": 9007199254740993}']::jsonb[]`,
    expected: '[{"v":[{"n":9007199254740993}]}]',
  },
  { expr: "'\\xdeadbeef'::bytea", expected: '[{"v":"\\\\xdeadbeef"}]' },
  { expr: "ARRAY['\\xdeadbeef'::bytea]", expected: '[{"v":["\\\\xdeadbeef"]}]' },
  {
    expr: "'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid",
    expected: '[{"v":"a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"}]',
  },
  { expr: "'192.168.0.1/24'::inet", expected: '[{"v":"192.168.0.1/24"}]' },
  { expr: "'08:00:2b:01:02:03'::macaddr", expected: '[{"v":"08:00:2b:01:02:03"}]' },
  { expr: "B'10110'::bit(5)", expected: '[{"v":"10110"}]' },
  { expr: "'(1.5,2)'::point", expected: '[{"v":"(1.5,2)"}]' },
  { expr: "'<(1,2),3>'::circle", expected: '[{"v":"<(1,2),3>"}]' },
  { expr: "ARRAY['(1,2)'::point]", expected: '[{"v":["(1,2)"]}]' },
  { expr: "ARRAY['<(1,2),3>'::circle]", expected: '[{"v":["<(1,2),3>"]}]' },
  { expr: "'(3,4),(1,2)'::box", expected: '[{"v":"(3,4),(1,2)"}]' },
  { expr: 'int4range(1,5)', expected: '[{"v":"[1,5)"}]' },
  { expr: 'int4multirange(int4range(1,5), int4range(10,12))', expected: '[{"v":"{[1,5),[10,12)}"}]', minMajor: 14 },
  { expr: "'a fat cat'::tsvector", expected: `[{"v":"'a' 'cat' 'fat'"}]` },
  { expr: "'<a>1</a>'::xml", expected: '[{"v":"<a>1</a>"}]' },
  { expr: "ROW(1,'x')::vt_composite", expected: '[{"v":"(1,x)"}]' },
  { expr: "'b'::vt_enum", expected: '[{"v":"b"}]' },
  // pg has no parser for user-defined array types, so an enum array arrives as Postgres' array literal.
  { expr: "ARRAY['a','b']::vt_enum[]", expected: '[{"v":"{a,b}"}]' },
  { expr: "ARRAY['x',NULL,'NULL']", expected: '[{"v":["x",null,"NULL"]}]' },
  { expr: 'ARRAY[true,false,NULL]', expected: '[{"v":[true,false,null]}]' },
  { expr: 'ARRAY[[1,2],[3,4]]', expected: '[{"v":[[1,2],[3,4]]}]' },
];

function toolResult(raw: unknown): { text: string; isError: boolean } {
  const { content, isError } = CallToolResultSchema.parse(raw);
  const [item] = content;
  if (item?.type !== 'text') {
    throw new Error('Expected a text content item');
  }
  return { text: item.text, isError: isError === true };
}

describeWithPostgres('execute_sql value types', ({ connectionString, version }) => {
  const major = Number(version);
  let admin: pg.Pool | undefined;
  let registry: DatabaseRegistry | undefined;
  let client: Client | undefined;
  let originalTz: string | undefined;

  beforeAll(async () => {
    originalTz = process.env.TZ;
    // A Date-based regression would show as a value shifted by this zone.
    process.env.TZ = 'Pacific/Auckland';

    admin = new pg.Pool({ connectionString: connectionString() });
    await admin.query('DROP TYPE IF EXISTS vt_composite');
    await admin.query('DROP TYPE IF EXISTS vt_enum');
    await admin.query("CREATE TYPE vt_enum AS ENUM ('a', 'b')");
    await admin.query('CREATE TYPE vt_composite AS (a int, b text)');

    registry = new DatabaseRegistry({
      accessMode: AccessMode.UNRESTRICTED,
      idleMinutes: 0,
      statementTimeoutSeconds: 0,
      databases: [{ name: 'app', source: 'cli', uri: { uri: connectionString() } }],
      servers: [],
    });
    client = await connectClient(createServer(registry));
  });

  afterAll(async () => {
    if (originalTz === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTz;
    }
    await client?.close();
    await registry?.closeAll();
    await admin?.end();
  });

  test.for(cases)('returns $expr exactly as Postgres sends it', async ({ expr, expected, minMajor }, ctx) => {
    if (minMajor !== undefined && major < minMajor) {
      ctx.skip();
    }

    if (!client) {
      throw new Error('Client was not set up');
    }
    const result = toolResult(
      await client.callTool({
        name: 'execute_sql',
        arguments: { database: 'app', sql: `SET TIME ZONE 'UTC'; SELECT ${expr} AS v` },
      })
    );

    expect(result).toEqual({ text: expected, isError: false });
  });
});
