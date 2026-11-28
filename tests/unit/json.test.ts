import { describe, expect, it } from 'vitest';

import { parseJsonLossless } from '../../src/json.ts';
import { toJson } from '../../src/tools/result.ts';

describe('parseJsonLossless with toJson', () => {
  it('keeps the digits of numbers a double cannot hold and normalises the rest', () => {
    const parsed = parseJsonLossless(
      '{"a":9007199254740993,"b":1e400,"c":3.14159265358979323846,"d":12.50,"e":[1,0.1,1e2,-0]}'
    );
    expect(toJson(parsed)).toBe(
      '{"a":9007199254740993,"b":1e400,"c":3.14159265358979323846,"d":12.5,"e":[1,0.1,100,0]}'
    );
  });
});

describe(toJson, () => {
  it('writes a bigint as an exact number and non-finite floats as strings', () => {
    expect(toJson({ big: 9_007_199_254_740_993n, nan: Number.NaN, up: Infinity, down: -Infinity })).toBe(
      '{"big":9007199254740993,"nan":"NaN","up":"Infinity","down":"-Infinity"}'
    );
  });
});
