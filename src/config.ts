import type { ParseError } from 'jsonc-parser';
import { parse } from 'jsonc-parser';
import { z } from 'zod';

import type { CliOptions } from './cli.ts';
import { CliError, MAX_IDLE_MINUTES } from './cli.ts';
import type { DiscoverySource, ExplicitDatabase, RegistryOptions, UriSpec } from './database-registry.ts';
import { NOT_A_POSTGRES_URL, isPostgresUrl } from './database-registry.ts';
import { ACCESS_MODES, AccessMode } from './sql/driver-factory.ts';

export const DEFAULT_IDLE_MINUTES = 10;

const DATABASE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const VARIABLE_PATTERN = /\$\{(?<name>[A-Za-z_][A-Za-z0-9_]*)\}/gu;

const uriSchema = z.object({ uri: z.string() }).strict();

const configSchema = z
  .object({
    accessMode: z.enum(ACCESS_MODES).optional(),
    idleMinutes: z.number().int().nonnegative().max(MAX_IDLE_MINUTES).optional(),
    databases: z.record(z.string(), uriSchema).optional(),
    servers: z
      .array(
        z
          .object({
            uri: z.string(),
            prefix: z.string().default(''),
            include: z.array(z.string()).default(['*']),
            exclude: z.array(z.string()).default([]),
          })
          .strict()
      )
      .optional(),
  })
  .strict();

export function envVarName(name: string): string {
  return `MCP_${name.toUpperCase().replaceAll('-', '_')}_DATABASE_URI`;
}

/** Replace every `${NAME}` from env; an unset variable yields an error spec. */
function expandUri(raw: string, env: NodeJS.ProcessEnv): UriSpec {
  let missing: string | undefined;
  const uri = raw.replaceAll(VARIABLE_PATTERN, (_match, name: string) => {
    const value = env[name];
    if (value === undefined || value === '') {
      missing ??= name;
      return '';
    }
    return value;
  });
  return missing === undefined ? { uri } : { error: `environment variable ${missing} is not set` };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

function cliDatabases(names: string[], env: NodeJS.ProcessEnv): ExplicitDatabase[] {
  const seenNames = new Set<string>();
  const seenVars = new Map<string, string>();
  return names.map((name) => {
    if (!DATABASE_NAME_PATTERN.test(name)) {
      throw new CliError(
        `argument --database: invalid name '${name}' (use letters, digits, '_' and '-', starting with a letter or digit)`
      );
    }
    if (seenNames.has(name)) {
      throw new CliError(`argument --database: duplicate name '${name}'`);
    }
    seenNames.add(name);
    const variable = envVarName(name);
    const clash = seenVars.get(variable);
    if (clash !== undefined) {
      throw new CliError(`argument --database: '${name}' and '${clash}' both map to ${variable}`);
    }
    seenVars.set(variable, name);
    const value = env[variable];
    const uri: UriSpec = value ? { uri: value } : { error: `environment variable ${variable} is not set` };
    return { name, source: 'cli', uri };
  });
}

function readConfig(path: string, readFile: (path: string) => string): z.infer<typeof configSchema> {
  let text: string;
  try {
    text = readFile(path);
  } catch (error) {
    throw new CliError(`cannot read config file ${path}: ${errorMessage(error)}`, { cause: error });
  }
  // JSONC: comments and trailing commas are allowed. The error names only the offset, never the text around
  // it, which can be part of a literal URI with a password.
  const errors: ParseError[] = [];
  const json: unknown = parse(text, errors, { allowTrailingComma: true });
  const [firstError] = errors;
  if (firstError) {
    throw new CliError(`invalid JSON in config file ${path} at position ${firstError.offset}`);
  }
  const parsed = configSchema.safeParse(json);
  if (!parsed.success) {
    throw new CliError(`invalid config file ${path}: ${describeIssues(parsed.error)}`);
  }
  return parsed.data;
}

function configServer(
  server: { uri: string; prefix: string; include: string[]; exclude: string[] },
  index: number,
  env: NodeJS.ProcessEnv
): DiscoverySource {
  if (!server.uri.includes('${') && !isPostgresUrl(server.uri)) {
    throw new CliError(`invalid config: servers.${index}.uri: ${NOT_A_POSTGRES_URL}`);
  }
  return { uri: expandUri(server.uri, env), prefix: server.prefix, include: server.include, exclude: server.exclude };
}

/** Resolve CLI flags and the optional config file into registry options. */
export function resolveConfig(
  cli: Pick<CliOptions, 'accessMode' | 'databases' | 'configPath' | 'idleMinutes'>,
  env: NodeJS.ProcessEnv,
  readFile: (path: string) => string
): Omit<RegistryOptions, 'poolFactory' | 'getSqlDriver'> {
  if (cli.databases.length > 0 && cli.configPath !== undefined) {
    throw new CliError('arguments --database and --config are mutually exclusive');
  }

  if (cli.configPath === undefined) {
    if (cli.databases.length === 0) {
      throw new CliError('no databases configured: pass --database NAME or --config FILE');
    }
    return {
      accessMode: cli.accessMode ?? AccessMode.UNRESTRICTED,
      idleMinutes: cli.idleMinutes ?? DEFAULT_IDLE_MINUTES,
      databases: cliDatabases(cli.databases, env),
      servers: [],
    };
  }

  const config = readConfig(cli.configPath, readFile);
  const databases: ExplicitDatabase[] = Object.entries(config.databases ?? {}).map(([name, entry]) => ({
    name,
    source: 'config',
    uri: expandUri(entry.uri, env),
  }));
  const servers = (config.servers ?? []).map((server, index) => configServer(server, index, env));
  if (databases.length === 0 && servers.length === 0) {
    throw new CliError(`invalid config file ${cli.configPath}: define at least one database or server`);
  }

  return {
    accessMode: cli.accessMode ?? config.accessMode ?? AccessMode.UNRESTRICTED,
    idleMinutes: cli.idleMinutes ?? config.idleMinutes ?? DEFAULT_IDLE_MINUTES,
    databases,
    servers,
  };
}
