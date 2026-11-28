import { expect, it as test } from 'vitest';

import { literal } from '../../../src/sql/literal.ts';

test('an object in an array literal is written as its escaped JSON text', () => {
  // Array element: "{\"a\":\"x\\\"y\"}"; pg.escapeLiteral then doubles each backslash and prefixes E.
  expect(literal([{ a: 'x"y' }])).toBe(String.raw` E'{"{\\"a\\":\\"x\\\\\\"y\\"}"}'`);
});
