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

const identity: TextParser = (value) => value;

const { builtins } = pg.types;

/**
 * Text-format parsers that return the value as Postgres sent it, or as exactly as a JS value can hold it: [scalar OID,
 * array OID, element parser]. Without these pg gives Dates (shifted by the host time zone, millisecond precision,
 * infinity as null), Buffers, objects for point, circle and interval, numeric[] elements parsed to doubles, and JSON
 * numbers rounded to a double. pg parses no other geometric array, so `box[]` and the like stay one string.
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
