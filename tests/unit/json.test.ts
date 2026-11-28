import { expect, test } from 'vitest';

import { isJsonObject, parseJsonLossless, toJson } from '../../src/json.ts';

test('parseJsonLossless and toJson write every json number back exactly as sent', () => {
  const text =
    '{"a":9007199254740993,"b":1e400,"c":3.14159265358979323846,"n":1000003000003000064,"d":12.50,"e":[1,0.1,1E+2,-0]}';
  expect(toJson(parseJsonLossless(text))).toBe(text);
});

test('toJson writes a bigint as an exact number and non-finite floats as strings', () => {
  expect(toJson({ big: 9_007_199_254_740_993n, nan: Number.NaN, up: Infinity, down: -Infinity })).toBe(
    '{"big":9007199254740993,"nan":"NaN","up":"Infinity","down":"-Infinity"}'
  );
});

test('isJsonObject is false for a raw JSON value', () => {
  expect(isJsonObject(JSON.rawJSON('9007199254740993'))).toBe(false);
});
