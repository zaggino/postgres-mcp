export function log(level: string, message: string): void {
  process.stderr.write(`${level}: ${message}\n`);
}
