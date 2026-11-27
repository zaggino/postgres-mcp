#!/usr/bin/env node
import { errorMessage } from './errors.ts';
import { logLine } from './log.ts';
import { main } from './main.ts';

main(process.argv.slice(2)).catch((error: unknown) => {
  logLine(errorMessage(error));
  process.exit(1);
});
