import pg from 'pg';
import { parse as parseArray } from 'postgres-array';

import { parseJsonLossless } from '../json.ts';

type TextParser = (value: string) => unknown;

function parseInt8(value: string): number | bigint {
  const asNumber = Number(value);
  return Number.isSafeInteger(asNumber) ? asNumber : BigInt(value);
}

/** An array literal parsed with `convert` applied to each element (NULL stays null, dimensions nest). */
function arrayOf(convert: TextParser): TextParser {
  return (value) => parseArray(value, convert);
}

/**
 * A Postgres array literal as nested JS arrays, for element types pg has no array parser for. Ignores a leading
 * `[l:u]=` dimension decoration; `convert` is applied to every element that is not NULL (an unquoted NULL).
 */
export function parseArrayLiteral(text: string, delimiter: string, convert: TextParser): unknown {
  let pos = text.startsWith('[') ? text.indexOf('=') + 1 : 0;

  const fail = (): never => {
    throw new Error(`Malformed array literal: ${text}`);
  };
  const skipSpace = () => {
    while (pos < text.length && /\s/u.test(text.charAt(pos))) {
      pos += 1;
    }
  };
  const readQuoted = (): string => {
    let out = '';
    pos += 1;
    while (pos < text.length && text.charAt(pos) !== '"') {
      if (text.charAt(pos) === '\\') {
        pos += 1;
      }
      out += text.charAt(pos);
      pos += 1;
    }
    if (pos >= text.length) {
      return fail();
    }
    pos += 1;
    return out;
  };
  const readUnquoted = (): string => {
    let out = '';
    while (pos < text.length && text.charAt(pos) !== delimiter && text.charAt(pos) !== '}') {
      if (text.charAt(pos) === '\\') {
        pos += 1;
      }
      out += text.charAt(pos);
      pos += 1;
    }
    return out.trim();
  };
  const readElement = (): unknown => {
    skipSpace();
    const char = text.charAt(pos);
    if (char === '{') {
      return readList();
    }
    if (char === '"') {
      return convert(readQuoted());
    }
    const raw = readUnquoted();
    return raw.toUpperCase() === 'NULL' ? null : convert(raw);
  };
  const readList = (): unknown[] => {
    if (text.charAt(pos) !== '{') {
      return fail();
    }
    pos += 1;
    const items: unknown[] = [];
    skipSpace();
    if (text.charAt(pos) === '}') {
      pos += 1;
      return items;
    }
    for (;;) {
      items.push(readElement());
      skipSpace();
      const next = text.charAt(pos);
      pos += 1;
      if (next === '}') {
        return items;
      }
      if (next !== delimiter) {
        return fail();
      }
    }
  };

  return readList();
}

const identity: TextParser = (value) => value;

const { builtins } = pg.types;

/**
 * Text-format parsers that return the value as Postgres sent it, or as exactly as a JS value can hold it: [scalar OID,
 * array OID, element parser]. Without these pg gives Dates (shifted by the host time zone, millisecond precision,
 * infinity as null), Buffers, objects for point, circle and interval, numeric[] elements parsed to doubles, and JSON
 * numbers rounded to a double. pg parses no other geometric array, so `box[]` and the like stay one string here; `execute_sql` decodes them with
 * `parseArrayLiteral` (`src/sql/array-types.ts`).
 */
const TYPES: readonly (readonly [number, number, TextParser])[] = [
  [builtins.DATE, 1182 /* date[] */, identity],
  [builtins.TIMESTAMP, 1115 /* timestamp[] */, identity],
  [builtins.TIMESTAMPTZ, 1185 /* timestamptz[] */, identity],
  [builtins.INTERVAL, 1187 /* interval[] */, identity],
  [builtins.BYTEA, 1001 /* bytea[] */, identity],
  // pg.types.builtins has no POINT.
  [600 /* point */, 1017 /* point[] */, identity],
  [builtins.CIRCLE, 719 /* circle[] */, identity],
  [builtins.NUMERIC, 1231 /* numeric[] */, identity],
  [builtins.INT8, 1016 /* int8[] */, parseInt8],
  [builtins.JSON, 199 /* json[] */, parseJsonLossless],
  [builtins.JSONB, 3807 /* jsonb[] */, parseJsonLossless],
];

export const customTypes = new pg.TypeOverrides();
for (const [oid, arrayOid, parser] of TYPES) {
  customTypes.setTypeParser(oid, 'text', parser);
  customTypes.setTypeParser(arrayOid, 'text', arrayOf(parser));
}
