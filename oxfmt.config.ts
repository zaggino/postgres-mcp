import { defineConfig } from 'oxfmt';
import ultracite from 'ultracite/oxfmt';

export default defineConfig({
  ...ultracite,
  printWidth: 120,
  // The ultracite preset sets proseWrap: 'never', which would unwrap the
  // hand-wrapped markdown prose in README/docs into one-line paragraphs.
  // Keep the existing wrapping.
  proseWrap: 'preserve',
  singleQuote: true,
  ignorePatterns: [...(ultracite.ignorePatterns ?? []), '.claude', '.github'],
});
