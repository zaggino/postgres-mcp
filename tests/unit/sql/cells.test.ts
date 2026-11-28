import { describe, expect, it } from 'vitest';

import {
  bigint,
  cellText,
  int8,
  integer,
  nullableNumberArray,
  nullableText,
  numeric,
  text,
} from '../../../src/sql/cells.ts';

describe('cell readers', () => {
  it('reject a column the row does not have, naming it', () => {
    expect(() => text({ relname: 't' }, 'rel_name')).toThrow('Column "rel_name" is missing from the result');
  });

  it('reject NULL in a non-nullable reader and pass it through a nullable one', () => {
    expect(() => text({ name: null }, 'name')).toThrow('Column "name": expected text, got NULL');
    expect(nullableText({ name: null }, 'name')).toBeNull();
  });

  it('keep an int8 beyond a safe integer out of integer but return it from int8 and bigint', () => {
    const row = { id: 9_007_199_254_740_993n };
    expect(() => integer(row, 'id')).toThrow('expected integer, got bigint');
    expect(int8(row, 'id')).toBe(9_007_199_254_740_993n);
    expect(bigint({ id: 42 }, 'id')).toBe(42n);
  });

  it('parse numeric text to a number and reject text that is not a finite number', () => {
    expect(numeric({ rate: '0.9875' }, 'rate')).toBe(0.9875);
    expect(numeric({ rate: 0.5 }, 'rate')).toBe(0.5);
    expect(() => numeric({ rate: 'NaN' }, 'rate')).toThrow('expected a finite number, got string');
    expect(() => numeric({ rate: '' }, 'rate')).toThrow('expected a finite number');
  });

  it('accept only arrays of numbers as a number array', () => {
    expect(nullableNumberArray({ freqs: [0.5, 0.25] }, 'freqs')).toEqual([0.5, 0.25]);
    expect(() => nullableNumberArray({ freqs: '{0.5}' }, 'freqs')).toThrow('expected array of numbers, got string');
  });
});

describe(cellText, () => {
  it('writes objects and arrays as JSON and dates as ISO 8601', () => {
    expect(cellText({ a: [1, 2] })).toBe('{"a":[1,2]}');
    expect(cellText([1, 2])).toBe('[1,2]');
    expect(cellText(new Date('2026-01-02T03:04:05Z'))).toBe('2026-01-02T03:04:05.000Z');
    expect(cellText(12n)).toBe('12');
  });
});
