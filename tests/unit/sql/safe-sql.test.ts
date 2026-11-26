import { isDeepStrictEqual } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import { paramSqlToQuery } from '../../../src/sql/literal.ts';
import type { SqlExecutor } from '../../../src/sql/safe-sql.ts';
import { SafeSqlDriver } from '../../../src/sql/safe-sql.ts';

const PREFIX = '/* postgres-mcp */ ';

function setup() {
  const executeQuery = vi.fn<SqlExecutor['executeQuery']>(() => Promise.resolve([]));
  return { safeDriver: new SafeSqlDriver({ executeQuery }), executeQuery };
}

/**
 * True when every query is rejected with the message and none reaches the
 * driver; otherwise a description of what happened instead.
 */
async function blockedWith(message: string, ...queries: string[]): Promise<true | string> {
  const { safeDriver, executeQuery } = setup();
  const outcomes = await Promise.all(
    queries.map((query) =>
      safeDriver.executeQuery(query).then(
        () => `not rejected: ${query}`,
        (error: unknown) =>
          error instanceof Error && error.message.includes(message)
            ? undefined
            : `wrong rejection for ${query}: ${String(error)}`
      )
    )
  );
  const failure = outcomes.find((outcome) => outcome !== undefined);
  if (failure !== undefined) {
    return failure;
  }
  return executeQuery.mock.calls.length === 0 || 'driver was called';
}

function isBlocked(...queries: string[]): Promise<true | string> {
  return blockedWith('Error validating query', ...queries);
}

/**
 * True when every query runs once, in order, prefixed, with force-readonly;
 * otherwise a description of what happened instead.
 */
async function runsReadOnly(...queries: string[]): Promise<true | string> {
  const { safeDriver, executeQuery } = setup();
  for (const query of queries) {
    try {
      await safeDriver.executeQuery(query);
    } catch (error) {
      return `rejected ${query}: ${String(error)}`;
    }
  }
  const expected = queries.map((query) => [PREFIX + query, null, true]);
  return (
    isDeepStrictEqual(executeQuery.mock.calls, expected) ||
    `unexpected calls: ${JSON.stringify(executeQuery.mock.calls)}`
  );
}

/** The wrapper and underlying messages of a rejected query. */
async function rejection(query: string): Promise<{ message: string; cause: string }> {
  const { safeDriver } = setup();
  const error = await safeDriver.executeQuery(query).catch((error_: unknown) => error_);
  if (!(error instanceof Error)) {
    throw new Error('expected the query to be rejected');
  }
  return {
    message: error.message,
    cause: error.cause instanceof Error ? error.cause.message : error.message,
  };
}

describe(SafeSqlDriver, () => {
  it('allows simple SELECT statements', async () => {
    await expect(runsReadOnly('SELECT * FROM users WHERE age > 18')).resolves.toBe(true);
  });

  it('blocks UPDATE statements', async () => {
    await expect(isBlocked("UPDATE users SET status = 'active' WHERE id = 1")).resolves.toBe(true);
  });

  it('allows SELECT with JOIN', async () => {
    await expect(
      runsReadOnly(`
    SELECT users.name, orders.order_date
    FROM users
    INNER JOIN orders ON users.id = orders.user_id
    WHERE orders.status = 'pending'
    `)
    ).resolves.toBe(true);
  });

  it('allows SHOW statements', async () => {
    await expect(runsReadOnly('SHOW search_path')).resolves.toBe(true);
  });

  it('blocks SET statements', async () => {
    await expect(isBlocked('SET search_path TO public')).resolves.toBe(true);
  });

  it('allows SELECT with arithmetic expressions', async () => {
    await expect(runsReadOnly('SELECT id, price * quantity as total FROM orders')).resolves.toBe(true);
  });

  it('allows SELECT current_user', async () => {
    await expect(runsReadOnly('SELECT current_user')).resolves.toBe(true);
  });

  it('blocks DROP TABLE statements', async () => {
    await expect(isBlocked('DROP TABLE users')).resolves.toBe(true);
  });

  it('blocks DELETE FROM statements', async () => {
    await expect(isBlocked("DELETE FROM users WHERE status = 'inactive'")).resolves.toBe(true);
  });

  it('allows SELECT with subqueries', async () => {
    await expect(
      runsReadOnly(`
    SELECT name FROM users
    WHERE id IN (SELECT user_id FROM orders WHERE total > 1000)
    `)
    ).resolves.toBe(true);
  });

  it('blocks SQL injection via a second statement', async () => {
    await expect(
      isBlocked(`
    SELECT * FROM users; DROP TABLE users;
    `)
    ).resolves.toBe(true);
  });

  it('allows UNION queries', async () => {
    await expect(
      runsReadOnly(`
    SELECT id, name FROM users
    UNION
    SELECT NULL, concat(table_name) FROM information_schema.tables
    `)
    ).resolves.toBe(true);
  });

  it('blocks SELECT INTO statements', async () => {
    await expect(
      isBlocked(`
    SELECT id, name
    INTO new_table
    FROM users
    `)
    ).resolves.toBe(true);
  });

  it('blocks SELECT FOR UPDATE statements', async () => {
    await expect(
      isBlocked(`
    SELECT id, name
    FROM users
    FOR UPDATE
    `)
    ).resolves.toBe(true);
  });

  it('blocks SELECT with explicit locking clauses', async () => {
    await expect(
      isBlocked(`
    SELECT id, name
    FROM users
    FOR SHARE NOWAIT
    `)
    ).resolves.toBe(true);
  });

  it('blocks statements containing COMMIT', async () => {
    await expect(
      isBlocked(`
    SELECT id FROM users;
    COMMIT;
    SELECT name FROM users;
    `)
    ).resolves.toBe(true);
  });

  it('allows EXPLAIN (without ANALYZE) with bind variables', async () => {
    await expect(
      runsReadOnly(`
    EXPLAIN (FORMAT JSON)
    SELECT id, name
    FROM users
    WHERE age > $1 AND status = $2
    `)
    ).resolves.toBe(true);
  });

  it('blocks EXPLAIN ANALYZE', async () => {
    await expect(
      isBlocked(`
    EXPLAIN ANALYZE
    SELECT id, name FROM users
    `)
    ).resolves.toBe(true);
  });

  it('blocks transaction blocks', async () => {
    await expect(
      isBlocked(`
    BEGIN;
    SELECT id, name FROM users;
    `)
    ).resolves.toBe(true);
  });

  it('blocks queries with invalid SQL syntax', async () => {
    const queries = [
      'SELECT * FRMO users;',
      'SELECT * FROM users INNER JOON posts ON users.id = posts.user_id;',
      'SELECT * FROM users WHERE (age > 21 AND active = true;',
    ];
    await expect(blockedWith('Failed to parse SQL statement', ...queries)).resolves.toBe(true);
  });

  it('blocks CREATE INDEX statements', async () => {
    await expect(
      isBlocked(`
    CREATE INDEX idx_user_email ON users(email);
    `)
    ).resolves.toBe(true);
  });

  it('blocks DROP INDEX statements', async () => {
    await expect(
      isBlocked(`
    DROP INDEX idx_user_email;
    `)
    ).resolves.toBe(true);
  });

  it('blocks CREATE TABLE statements', async () => {
    await expect(
      isBlocked(`
    CREATE TABLE test_table (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    `)
    ).resolves.toBe(true);
  });

  it('blocks CREATE TABLE AS statements', async () => {
    await expect(
      isBlocked(`
    CREATE TABLE user_backup AS
    SELECT * FROM users;
    `)
    ).resolves.toBe(true);
  });

  it('blocks CREATE EXTENSION for extensions outside the allowlist', async () => {
    await expect(
      isBlocked(`
    CREATE EXTENSION pg_hack;
    `)
    ).resolves.toBe(true);
  });

  it('blocks DROP EXTENSION statements', async () => {
    await expect(
      isBlocked(`
    DROP EXTENSION pg_stat_statements;
    `)
    ).resolves.toBe(true);
  });

  it('allows complex SELECT queries for index metadata', async () => {
    await expect(
      runsReadOnly(`SELECT indexrelid::regclass AS index_name, array_agg(attname) AS columns,
    indisunique, indisprimary
    FROM pg_index i
    JOIN pg_attribute a ON a.attnum = ANY(i.indkey)
    WHERE i.indrelid IN (SELECT oid FROM pg_class WHERE relnamespace =
        (SELECT oid FROM pg_namespace WHERE nspname = 'public'))
    GROUP BY indexrelid, indisunique, indisprimary
    HAVING COUNT(array_agg(attname)) > 1`)
    ).resolves.toBe(true);
  });

  it('allows newly added functions', async () => {
    const { safeDriver } = setup();
    await expect(
      safeDriver.executeQuery(`
    SELECT pg_relation_filenode('foo');
    `)
    ).resolves.toEqual([]);
  });

  it('blocks disallowed functions', async () => {
    const queries = ['SELECT pg_sleep(1);', "SELECT pg_read_file('/etc/passwd');", "SELECT lo_import('/etc/passwd');"];
    await expect(isBlocked(...queries)).resolves.toBe(true);
  });

  it('allows session info functions', async () => {
    await expect(runsReadOnly('SELECT current_user, current_database(), version()')).resolves.toBe(true);
  });

  it('allows blocking pids functions', async () => {
    await expect(runsReadOnly('SELECT pg_blocking_pids(1234)')).resolves.toBe(true);
  });

  it('allows logfile functions', async () => {
    await expect(runsReadOnly('SELECT pg_current_logfile()')).resolves.toBe(true);
  });

  it('allows complex session info queries', async () => {
    await expect(
      runsReadOnly(`
    SELECT current_user, current_database(), version(),
           pg_backend_pid(), pg_blocking_pids(pg_backend_pid())
    `)
    ).resolves.toBe(true);
  });

  it('allows security privilege functions', async () => {
    await expect(runsReadOnly("SELECT has_table_privilege('user', 'table', 'SELECT')")).resolves.toBe(true);
  });

  it('allows complex queries using security privilege functions', async () => {
    await expect(
      runsReadOnly(
        `
        SELECT tablename, has_table_privilege(current_user, tablename, 'SELECT') as can_select,
               has_table_privilege(current_user, tablename, 'UPDATE') as can_update
        FROM pg_tables
        WHERE schemaname = 'public'
        ORDER BY tablename
        `,
        `
        SELECT proname, has_function_privilege(current_user, p.oid, 'EXECUTE') as can_execute
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public'
        `,
        `
        SELECT c.relname, a.attname,
               has_column_privilege(current_user, c.oid, a.attnum, 'SELECT') as can_select,
               has_column_privilege(current_user, c.oid, a.attnum, 'UPDATE') as can_update
        FROM pg_class c
        JOIN pg_attribute a ON c.oid = a.attrelid
        WHERE c.relname = 'mytable'
        AND a.attnum > 0
        AND NOT a.attisdropped
        ORDER BY a.attnum
        `
      )
    ).resolves.toBe(true);
  });

  it('allows security privilege functions inside subqueries', async () => {
    await expect(
      runsReadOnly(
        `
        SELECT nspname
        FROM pg_namespace
        WHERE has_schema_privilege(current_user, oid, 'USAGE')
        AND nspname NOT LIKE 'pg_%'
        ORDER BY nspname
        `,
        `
        SELECT t.tablename
        FROM pg_tables t
        WHERE EXISTS (
            SELECT 1
            FROM information_schema.columns c
            WHERE c.table_name = t.tablename
            AND has_column_privilege(current_user, t.tablename, c.column_name, 'SELECT')
        )
        AND t.schemaname = 'public'
        `
      )
    ).resolves.toBe(true);
  });

  it.each(['LIKE', 'ILIKE'])('allows %s with constant string patterns', async (operator) => {
    await expect(
      runsReadOnly(
        `SELECT name FROM users WHERE name ${operator} '%smith'`,
        `SELECT name FROM users WHERE name ${operator} 'john%'`,
        `SELECT name FROM users WHERE name ${operator} 'jo%hn'`,
        `SELECT name FROM users WHERE name ${operator} '%jo%hn%'`,
        `SELECT name FROM users WHERE name ${operator} '%john%'`
      )
    ).resolves.toBe(true);
  });

  it('allows date/time functions', async () => {
    await expect(
      runsReadOnly(
        "SELECT age(timestamp '2001-04-10', timestamp '1957-06-13')",
        'SELECT clock_timestamp()',
        'SELECT current_date',
        'SELECT current_time',
        'SELECT current_timestamp',
        "SELECT date_part('year', timestamp '2001-02-16')",
        "SELECT date_trunc('hour', timestamp '2001-02-16 20:38:40')",
        "SELECT extract(year from timestamp '2001-02-16 20:38:40')",
        "SELECT isfinite(timestamp '2001-02-16')",
        "SELECT justify_days(interval '35 days')",
        "SELECT justify_hours(interval '27 hours')",
        "SELECT justify_interval(interval '1 year -1 hour')",
        'SELECT localtime',
        'SELECT localtimestamp',
        'SELECT make_date(2013, 7, 15)',
        'SELECT make_interval(years := 1)',
        'SELECT make_time(8, 15, 23.5)',
        'SELECT make_timestamp(2013, 7, 15, 8, 15, 23.5)',
        'SELECT make_timestamptz(2013, 7, 15, 8, 15, 23.5)',
        'SELECT now()',
        'SELECT statement_timestamp()',
        'SELECT timeofday()',
        'SELECT transaction_timestamp()'
      )
    ).resolves.toBe(true);
  });

  it('allows type conversion functions', async () => {
    await expect(
      runsReadOnly(
        "SELECT CAST('100' AS integer)",
        "SELECT '100'::integer",
        "SELECT text '100'",
        "SELECT bool 'true'",
        "SELECT int2 '100'",
        "SELECT int4 '100'",
        "SELECT int8 '100'",
        "SELECT float4 '100.0'",
        "SELECT float8 '100.0'",
        "SELECT numeric '100.0'",
        "SELECT date '2001-10-05'",
        "SELECT time '04:05:06.789'",
        "SELECT timetz '04:05:06.789-08'",
        "SELECT timestamp '2001-10-05 04:05:06.789'",
        "SELECT timestamptz '2001-10-05 04:05:06.789-08'",
        "SELECT interval '1 year 2 months 3 days'"
      )
    ).resolves.toBe(true);
  });

  it('allows regexp functions', async () => {
    await expect(runsReadOnly("SELECT regexp_replace('Hello World', 'World', 'PostgreSQL')")).resolves.toBe(true);
  });

  it('allows complex type conversion queries', async () => {
    await expect(
      runsReadOnly(`
    SELECT to_char(current_timestamp, 'YYYY-MM-DD'),
           to_date('2023-01-01'),
           to_timestamp('2023-01-01 12:00:00'),
           to_number('123.45', '999.99')
    `)
    ).resolves.toBe(true);
  });

  it('allows network functions', async () => {
    await expect(runsReadOnly('SELECT inet_client_addr(), inet_client_port()')).resolves.toBe(true);
  });

  it('allows network functions in complex queries', async () => {
    await expect(
      runsReadOnly(`
    SELECT inet_client_addr() as client_ip,
           inet_client_port() as client_port,
           inet_server_addr() as server_ip,
           inet_server_port() as server_port
    `)
    ).resolves.toBe(true);
  });

  it('allows notification and server functions', async () => {
    await expect(runsReadOnly('SELECT pg_listening_channels(), pg_postmaster_start_time()')).resolves.toBe(true);
  });

  it('allows minmax expressions', async () => {
    await expect(runsReadOnly('SELECT GREATEST(1, 2, 3), LEAST(1, 2, 3)')).resolves.toBe(true);
  });

  it('allows row expressions', async () => {
    await expect(runsReadOnly('SELECT ROW(1, 2, 3) = ROW(1, 2, 3)')).resolves.toBe(true);
  });

  it('allows extension check queries', async () => {
    await expect(runsReadOnly("SELECT extname, extversion FROM pg_extension WHERE extname = 'hypopg'")).resolves.toBe(
      true
    );
  });

  it('allows CREATE EXTENSION for allowlisted extensions', async () => {
    await expect(runsReadOnly('CREATE EXTENSION IF NOT EXISTS hypopg')).resolves.toBe(true);
  });

  it('allows hypopg create index queries', async () => {
    await expect(runsReadOnly("SELECT * FROM hypopg_create_index('CREATE INDEX idx ON users(id)')")).resolves.toBe(
      true
    );
  });

  it('allows hypopg reset queries', async () => {
    await expect(runsReadOnly('SELECT * FROM hypopg_reset()')).resolves.toBe(true);
  });

  it('allows hypopg list indexes queries', async () => {
    await expect(runsReadOnly('SELECT * FROM hypopg_list_indexes()')).resolves.toBe(true);
  });

  it('allows pg_stat_statements queries', async () => {
    await expect(runsReadOnly('SELECT * FROM pg_stat_statements ORDER BY calls DESC LIMIT 10')).resolves.toBe(true);
  });

  it('allows pg_indexes queries', async () => {
    await expect(runsReadOnly("SELECT * FROM pg_indexes WHERE schemaname = 'public'")).resolves.toBe(true);
  });

  it('allows pg_stats queries', async () => {
    await expect(runsReadOnly("SELECT * FROM pg_stats WHERE schemaname = 'public'")).resolves.toBe(true);
  });

  it('allows EXPLAIN queries', async () => {
    await expect(runsReadOnly('EXPLAIN SELECT * FROM users')).resolves.toBe(true);
  });

  it('allows a query built from SQL parameters', async () => {
    const queryTemplate = `
    SELECT queryid, query, calls, total_exec_time/calls as avg_exec_time
    FROM pg_stat_statements
    WHERE calls >= {}
    AND total_exec_time/calls >= {}
    ORDER BY total_exec_time DESC
    LIMIT {}
    `;

    await expect(runsReadOnly(paramSqlToQuery(queryTemplate, [50, 5, 100]))).resolves.toBe(true);
  });

  it('handles multiple queries in sequence', async () => {
    await expect(runsReadOnly('SELECT * FROM users', 'SELECT * FROM orders')).resolves.toBe(true);
  });

  it('allows queries with comments', async () => {
    await expect(
      runsReadOnly(`
    -- Get user information
    SELECT id, name, email
    FROM users
    WHERE status = 'active'
    -- Only get active users
    `)
    ).resolves.toBe(true);
  });

  it('allows queries with extra whitespace', async () => {
    await expect(
      runsReadOnly(`
    SELECT    id,
              name,
              email
    FROM      users
    WHERE     status = 'active'
    ORDER BY  name
    `)
    ).resolves.toBe(true);
  });

  it('blocks dangerous functions in the FROM clause', async () => {
    const queries = [
      "SELECT * FROM pg_read_file('/etc/passwd') AS t",
      "SELECT * FROM pg_ls_dir('/etc') AS t",
      "SELECT * FROM pg_read_binary_file('/etc/passwd') AS t",
      "SELECT * FROM pg_stat_file('/etc/passwd') AS t",
    ];
    await expect(isBlocked(...queries)).resolves.toBe(true);
  });

  it('allows permitted functions in the FROM clause', async () => {
    await expect(runsReadOnly('SELECT * FROM unnest(ARRAY[1,2,3]) AS t')).resolves.toBe(true);
  });

  it.each([
    // VALUES lists are arrays of lists in the parse tree
    "VALUES (pg_read_file('/etc/passwd'))",
    "SELECT * FROM (VALUES (pg_read_file('/etc/passwd'))) AS v(a)",
    "SELECT 1 WHERE 'x' IN (VALUES (pg_ls_dir('/')))",
    // FROM-clause function shapes
    "SELECT * FROM LATERAL pg_read_file('/etc/passwd') AS t",
    "SELECT * FROM unnest(ARRAY[1]) AS u, LATERAL pg_ls_dir('/') AS t",
    "SELECT * FROM ROWS FROM (unnest(ARRAY[1]), pg_read_file('/etc/passwd')) AS t",
    "SELECT * FROM pg_read_file('/etc/passwd') WITH ORDINALITY AS t",
    "SELECT * FROM (SELECT * FROM pg_ls_dir('/') AS t) AS s",
    "WITH c AS (SELECT * FROM pg_read_file('/etc/passwd') AS t) SELECT * FROM c",
  ])('names and blocks a disallowed function nested in %s', async (query) => {
    const { message, cause } = await rejection(query);
    expect(message).toContain('Error validating query');
    expect(cause).toContain('is not allowed');
    expect(cause.includes('pg_read_file') || cause.includes('pg_ls_dir')).toBe(true);
  });

  it('validates column definition lists inside ROWS FROM', async () => {
    // ColumnDef is not an allowed node type, so this is rejected just like the
    // ordinary `AS t(a int)` alias form.
    const ordinary = 'SELECT * FROM json_to_record(\'{"a":1}\') AS t(a int)';
    const nested = 'SELECT * FROM ROWS FROM (json_to_record(\'{"a":1}\') AS (a int)) AS t';
    const causes = await Promise.all([ordinary, nested].map(async (query) => (await rejection(query)).cause));
    for (const cause of causes) {
      expect(cause).toContain('ColumnDef');
    }
  });

  it('no longer skips a function hidden in a ROWS FROM column definition list', async () => {
    await expect(
      isBlocked('SELECT * FROM ROWS FROM (json_to_record(\'{"a":1}\') AS (a numeric(pg_sleep(0)::int))) AS t')
    ).resolves.toBe(true);
  });

  it.each([
    'SELECT * FROM generate_series(1, 10)',
    'SELECT * FROM generate_subscripts(ARRAY[1, 2, 3], 1)',
    'SELECT * FROM unnest(ARRAY[1, 2, 3]) WITH ORDINALITY AS t(v, n)',
    'SELECT * FROM unnest(ARRAY[1, 2, 3]) AS u, LATERAL unnest(ARRAY[4, 5]) AS t',
    "VALUES (1, 'a'), (2, 'b')",
    'SELECT * FROM (VALUES (1), (2)) AS v(a)',
    'SELECT 1 WHERE 1 IN (VALUES (1), (2))',
  ])('keeps allowing the nested construct %s', async (query) => {
    await expect(runsReadOnly(query)).resolves.toBe(true);
  });
});
