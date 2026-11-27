/* oxlint-disable no-template-curly-in-string -- config values contain literal ${VAR} references */
import { describe, expect, it } from 'vitest';

import { parseCli } from '../../src/cli.ts';
import { resolveConfig } from '../../src/config.ts';

const noFile = (): string => {
  throw new Error('unexpected file read');
};

function cli(overrides: Partial<Parameters<typeof resolveConfig>[0]> = {}): Parameters<typeof resolveConfig>[0] {
  return {
    accessMode: undefined,
    databases: [],
    configPath: undefined,
    idleMinutes: undefined,
    statementTimeoutSeconds: undefined,
    ...overrides,
  };
}

function withConfig(
  config: unknown,
  env: NodeJS.ProcessEnv = {},
  overrides: Partial<Parameters<typeof resolveConfig>[0]> = {}
) {
  return resolveConfig(cli({ configPath: 'c.json', ...overrides }), env, () => JSON.stringify(config));
}

describe('--database resolution', () => {
  it('reads the URI from MCP_<NAME>_DATABASE_URI with the name uppercased and dashes as underscores', () => {
    const result = resolveConfig(cli({ databases: ['app-x'] }), { MCP_APP_X_DATABASE_URI: 'postgres://h/db' }, noFile);
    expect(result.databases).toEqual([{ name: 'app-x', source: 'cli', uri: { uri: 'postgres://h/db' } }]);
  });

  it('records an unset variable on the entry instead of throwing', () => {
    const result = resolveConfig(cli({ databases: ['app'] }), {}, noFile);
    expect(result.databases[0]?.uri).toEqual({ error: 'environment variable MCP_APP_DATABASE_URI is not set' });
  });

  it('rejects names that map to the same variable', () => {
    expect(() => resolveConfig(cli({ databases: ['a-b', 'a_b'] }), {}, noFile)).toThrow(
      /both map to MCP_A_B_DATABASE_URI/u
    );
  });

  it('rejects --database together with --config', () => {
    expect(() => resolveConfig(cli({ databases: ['a'], configPath: 'c.json' }), {}, noFile)).toThrow(
      /mutually exclusive/u
    );
  });

  it('rejects having neither --database nor --config', () => {
    expect(() => resolveConfig(cli(), {}, noFile)).toThrow(/no databases configured/u);
  });
});

describe(parseCli, () => {
  it('rejects a positional database URL', () => {
    expect(() => parseCli(['postgresql://h/db'])).toThrow(/unrecognized arguments: postgresql:\/\/h\/db/u);
  });

  it('collects repeated --database flags', () => {
    expect(parseCli(['--database', 'a', '--database', 'b'])?.databases).toEqual(['a', 'b']);
  });

  it('rejects a negative --idle-minutes', () => {
    expect(() => parseCli(['--database', 'a', '--idle-minutes=-1'])).toThrow(/--idle-minutes: must be between 0 and/u);
  });

  it('rejects a negative or non-integer --statement-timeout', () => {
    expect(() => parseCli(['--database', 'a', '--statement-timeout=-1'])).toThrow(
      /--statement-timeout: must be between 0 and/u
    );
    expect(() => parseCli(['--database', 'a', '--statement-timeout=1.5'])).toThrow(
      /--statement-timeout: invalid int value/u
    );
  });

  it('reads --statement-timeout as whole seconds', () => {
    expect(parseCli(['--database', 'a', '--statement-timeout=45'])?.statementTimeoutSeconds).toBe(45);
  });

  it('rejects --max-sessions below 1', () => {
    expect(() => parseCli(['--database', 'a', '--max-sessions=0'])).toThrow(/--max-sessions: must be at least 1/u);
  });

  it('refuses a non-loopback HTTP bind without --allowed-hosts and accepts it with one', () => {
    const args = ['--database', 'a', '--transport=sse', '--sse-host=0.0.0.0'];

    expect(() => parseCli(args)).toThrow(/--allowed-hosts/u);
    expect(parseCli([...args, '--allowed-hosts=*'])?.allowedHosts).toBe('any');
  });

  it.each([
    ['--allowed-hosts=::1', /--allowed-hosts: an IPv6 address must be written in brackets/u],
    ['--allowed-origins=app.example', /--allowed-origins: expected scheme:\/\/host/u],
    ['--allowed-hosts=*,a.example', /--allowed-hosts: '\*' cannot be combined/u],
  ])('rejects %s', (flag, message) => {
    expect(() => parseCli(['--database', 'a', flag])).toThrow(message);
  });

  it('rejects an empty --allowed-origins entry', () => {
    expect(() => parseCli(['--database', 'a', '--allowed-origins=https://a.example,'])).toThrow(
      /--allowed-origins: empty entry/u
    );
  });
});

describe('config file', () => {
  it('expands ${VAR} references inside a URI', () => {
    const result = withConfig({ databases: { app: { uri: 'postgres://u:${PW}@h/db' } } }, { PW: 'secret' });
    expect(result.databases[0]).toEqual({ name: 'app', source: 'config', uri: { uri: 'postgres://u:secret@h/db' } });
  });

  it('reports an unset variable on the entry', () => {
    const result = withConfig({ databases: { app: { uri: '${MISSING}' } } });
    expect(result.databases[0]?.uri).toEqual({ error: 'environment variable MISSING is not set' });
  });

  it('accepts comments and trailing commas', () => {
    const text = `{
      // line comment
      "databases": {
        /* block comment */
        "app": { "uri": "postgres://h/app", },
      },
    }`;
    const result = resolveConfig(cli({ configPath: 'c.jsonc' }), {}, () => text);

    expect(result.databases).toEqual([{ name: 'app', source: 'config', uri: { uri: 'postgres://h/app' } }]);
  });

  it('reports invalid JSON by position, line, column and error code without quoting the file', () => {
    const text = '{\n  // c\n  "databases": {"a": {"uri": "postgres://u:hunter2@h/d" }}';
    const read = () => resolveConfig(cli({ configPath: 'c.json' }), {}, () => text);

    expect(read).toThrow('invalid JSON in config file c.json at position 67 (line 3 column 59): CloseBraceExpected');
    expect(read).not.toThrow(/hunter2/u);
  });

  it('rejects an unknown top-level key', () => {
    expect(() => withConfig({ databases: { a: { uri: 'postgres://h/d' } }, extra: 1 })).toThrow(/extra/u);
  });

  it('rejects a config with no databases and no servers', () => {
    expect(() => withConfig({ accessMode: 'restricted' })).toThrow(/at least one database or server/u);
  });

  it('rejects a literal server uri that is not a postgres URL', () => {
    expect(() => withConfig({ servers: [{ uri: 'mysql://h/d' }] })).toThrow(
      /Server uri must be a postgres:\/\/ or postgresql:\/\/ URL/u
    );
  });

  it('applies defaults to a server', () => {
    const result = withConfig({ servers: [{ uri: 'postgres://h/postgres' }] });
    expect(result.servers).toEqual([
      { uri: { uri: 'postgres://h/postgres' }, prefix: '', include: ['*'], exclude: [] },
    ]);
  });
});

describe('statement timeout', () => {
  const databases = { a: { uri: 'postgres://h/d' } };

  it('lets --statement-timeout override the config value', () => {
    const result = withConfig({ statementTimeoutSeconds: 5, databases }, {}, { statementTimeoutSeconds: 0 });
    expect(result.statementTimeoutSeconds).toBe(0);
  });

  it('uses the config value when the flag is absent', () => {
    expect(withConfig({ statementTimeoutSeconds: 5, databases }).statementTimeoutSeconds).toBe(5);
  });

  it('defaults to 30 s in restricted mode and none in unrestricted mode', () => {
    expect(withConfig({ accessMode: 'restricted', databases }).statementTimeoutSeconds).toBe(30);
    expect(withConfig({ accessMode: 'unrestricted', databases }).statementTimeoutSeconds).toBe(0);
  });

  it('rejects a config value above what statement_timeout can hold', () => {
    expect(() => withConfig({ statementTimeoutSeconds: 2_147_484, databases })).toThrow(/statementTimeoutSeconds/u);
  });
});

describe('precedence', () => {
  const config = { accessMode: 'unrestricted', idleMinutes: 3, databases: { a: { uri: 'postgres://h/d' } } };

  it('lets CLI access mode and idle minutes override the config', () => {
    const result = withConfig(config, {}, { accessMode: 'restricted', idleMinutes: 0 });
    expect([result.accessMode, result.idleMinutes]).toEqual(['restricted', 0]);
  });

  it('uses config values when the CLI omits them', () => {
    const result = withConfig(config);
    expect([result.accessMode, result.idleMinutes]).toEqual(['unrestricted', 3]);
  });

  it('defaults to restricted and 10 minutes', () => {
    const result = withConfig({ databases: { a: { uri: 'postgres://h/d' } } });
    expect([result.accessMode, result.idleMinutes]).toEqual(['restricted', 10]);
  });
});
