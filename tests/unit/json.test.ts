import { expect, it as test } from 'vitest';

import { isJsonObject, parseJsonLossless, toJson } from '../../src/json.ts';

test('parseJsonLossless keeps a number a double cannot hold with its source digits', () => {
  const parsed = parseJsonLossless('{"a":9007199254740993,"b":1e400,"c":3.14159265358979323846}');
  expect(toJson(parsed)).toBe('{"a":9007199254740993,"b":1e400,"c":3.14159265358979323846}');
});

test('parseJsonLossless keeps the exact expansion of a large double, as EXPLAIN prints it, a plain number', () => {
  const parsed = parseJsonLossless('{"Plan Rows": 1000003000003000064, "Total Cost": 99999999999999991611392.00}');
  expect(parsed).toEqual({ 'Plan Rows': 1_000_003_000_003_000_064, 'Total Cost': 99_999_999_999_999_991_611_392 });
});

test('parseJsonLossless writes value-equal numbers in their shortest form', () => {
  expect(toJson(parseJsonLossless('{"d":12.50,"e":[1,0.1,1e2,-0]}'))).toBe('{"d":12.5,"e":[1,0.1,100,0]}');
});

test('toJson writes a bigint as an exact number and non-finite floats as strings', () => {
  expect(toJson({ big: 9_007_199_254_740_993n, nan: Number.NaN, up: Infinity, down: -Infinity })).toBe(
    '{"big":9007199254740993,"nan":"NaN","up":"Infinity","down":"-Infinity"}'
  );
});

test('isJsonObject is false for a raw JSON value', () => {
  expect(isJsonObject(JSON.rawJSON('9007199254740993'))).toBe(false);
});
