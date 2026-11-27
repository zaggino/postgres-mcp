/** The levels the server logs at; the level prefixes each stderr line. */
export type LogLevel = 'INFO' | 'WARNING' | 'ERROR';

/** Writes one line to stderr as is; the ported modules log upstream's text without a level. */
export function logLine(message: string): void {
  process.stderr.write(`${message}\n`);
}

export function log(level: LogLevel, message: string): void {
  logLine(`${level}: ${message}`);
}
