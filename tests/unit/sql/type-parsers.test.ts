import { expect, it as test } from 'vitest';

import { parseArrayLiteral } from '../../../src/sql/type-parsers.ts';

const text = (value: string) => value;

test('parseArrayLiteral splits on the given delimiter, so box[] elements keep their commas', () => {
  expect(parseArrayLiteral('{(3,4),(1,2);(5,6),(0,0)}', ';', text)).toEqual(['(3,4),(1,2)', '(5,6),(0,0)']);
});

test('parseArrayLiteral reads quoted escapes, NULL versus "NULL", and ignores a dimension prefix', () => {
  expect(parseArrayLiteral(String.raw`[0:2]={"a\"b\\c",NULL,"NULL"}`, ',', text)).toEqual(['a"b\\c', null, 'NULL']);
});

test('parseArrayLiteral nests multiple dimensions and converts every element', () => {
  expect(parseArrayLiteral('{{1,2},{3,NULL}}', ',', Number)).toEqual([
    [1, 2],
    [3, null],
  ]);
});
