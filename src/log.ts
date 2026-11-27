/** The levels the server logs at; the level prefixes each stderr line. */
export type LogLevel = 'INFO' | 'WARNING' | 'ERROR';

export function log(level: LogLevel, message: string): void {
  process.stderr.write(`${level}: ${message}\n`);
}
