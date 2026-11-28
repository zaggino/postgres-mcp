import type { IncomingMessage, ServerResponse } from 'node:http';

/** `'any'` accepts every value; otherwise the accepted entries. */
export type AllowList = 'any' | readonly string[];

/** Hosts a server can bind to without being reachable from the network. */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1']);

/** Options of the HTTP transport. Unset fields take their defaults where they are used. */
export interface HttpServerOptions {
  /** Host header values to accept besides loopback on a loopback bind. */
  allowedHosts?: AllowList;
  /** Origin header values to accept besides loopback on a loopback bind. */
  allowedOrigins?: AllowList;
  host: string;
  /** Most concurrent sessions; further ones get 503 (default: DEFAULT_MAX_SESSIONS). */
  maxSessions?: number;
  port: number;
  /** Minutes without a request before a session is closed; 0 = never (default: DEFAULT_SESSION_IDLE_MINUTES). */
  sessionIdleMinutes?: number;
}

/** The hostname of a Host header value or allow-list entry, and whether it names a port. */
function splitHostPort(value: string): { hasPort: boolean; hostname: string } {
  const lower = value.toLowerCase();
  if (lower.startsWith('[')) {
    const close = lower.indexOf(']');
    if (close !== -1) {
      return { hostname: lower.slice(0, close + 1), hasPort: close + 1 < lower.length };
    }
  }
  const colon = lower.lastIndexOf(':');
  if (colon === -1 || lower.indexOf(':') !== colon) {
    return { hostname: lower, hasPort: false };
  }
  return { hostname: lower.slice(0, colon), hasPort: true };
}

/** Why a `--allowed-hosts` entry is unusable, or null: `host`, `host:port`, `[v6]` or `[v6]:port`. */
export function hostEntryProblem(entry: string): string | null {
  if (entry.includes('/')) {
    return 'expected a host or host:port without a scheme or path';
  }
  if (entry.startsWith('[')) {
    return /^\[[0-9a-f:.]+\](?::\d+)?$/iu.test(entry) ? null : 'malformed bracketed IPv6 address';
  }
  if (entry.split(':').length > 2) {
    return 'an IPv6 address must be written in brackets, e.g. [::1]:8000';
  }
  return null;
}

/** Why an `--allowed-origins` entry is unusable, or null: it must be exactly `scheme://host[:port]`. */
export function originEntryProblem(entry: string): string | null {
  try {
    return new URL(entry).origin === entry.toLowerCase() ? null : 'expected scheme://host[:port] with no path';
  } catch {
    return 'expected scheme://host[:port]';
  }
}

function entriesOf(list: AllowList | undefined): readonly string[] {
  return list === undefined || list === 'any' ? [] : list;
}

/**
 * Builds the Host and Origin check applied to every request of an HTTP
 * transport: a web page cannot reach the server through a DNS name it controls
 * or from a foreign origin. Returns the rejection message, or null to accept.
 */
function createRequestGuard(options: HttpServerOptions, boundPort: number): (req: IncomingMessage) => string | null {
  const loopback = LOOPBACK_HOSTS.has(options.host);
  const loopbackHosts = loopback ? [`localhost:${boundPort}`, `127.0.0.1:${boundPort}`, `[::1]:${boundPort}`] : [];
  const loopbackOrigins = loopback
    ? [`http://localhost:${boundPort}`, `http://127.0.0.1:${boundPort}`, `http://[::1]:${boundPort}`]
    : [];

  const anyHost = options.allowedHosts === 'any';
  const anyOrigin = options.allowedOrigins === 'any';
  const hostEntries = [...loopbackHosts, ...entriesOf(options.allowedHosts)].map((entry) => entry.toLowerCase());
  // Entries naming a port match that exact Host value; the others match that hostname on any port.
  const exact = new Set(hostEntries.filter((entry) => splitHostPort(entry).hasPort));
  const hostnames = new Set(hostEntries.filter((entry) => !splitHostPort(entry).hasPort));
  const origins = new Set(
    [...loopbackOrigins, ...entriesOf(options.allowedOrigins)].map((entry) => entry.toLowerCase())
  );

  return (req) => {
    const hostHeader = req.headers.host;
    if (!anyHost) {
      const lower = hostHeader?.toLowerCase();
      if (lower === undefined || !(exact.has(lower) || hostnames.has(splitHostPort(lower).hostname))) {
        return `Invalid Host header: ${hostHeader}`;
      }
    }
    const originHeader = req.headers.origin;
    if (originHeader !== undefined && !anyOrigin && !origins.has(originHeader.toLowerCase())) {
      return `Invalid Origin header: ${originHeader}`;
    }
    return null;
  };
}

/** Wraps a request handler so requests failing the Host or Origin check get a 403. */
export function guardRequests(
  options: HttpServerOptions,
  boundPort: number,
  handler: (req: IncomingMessage, res: ServerResponse) => void
): (req: IncomingMessage, res: ServerResponse) => void {
  const guard = createRequestGuard(options, boundPort);
  return (req, res) => {
    const violation = guard(req);
    if (violation === null) {
      handler(req, res);
      return;
    }
    res
      .writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' })
      .end(violation);
  };
}
