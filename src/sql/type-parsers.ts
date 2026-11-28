import pg from 'pg';

import { parseJsonLossless } from '../json.ts';

type TextParser = (value: string) => unknown;

function parseInt8(value: string): number | bigint {
  const asNumber = Number(value);
  return Number.isSafeInteger(asNumber) ? asNumber : BigInt(value);
}

const TEXT_ARRAY_OID = 1009;

// pg types the OID as an enum and the parser as any; the OID is a plain number here.
const textParserFor = (oid: number): TextParser =>
  (pg.types.getTypeParser as (oid: number, format: 'text') => TextParser)(oid, 'text');

/** Parses a text[] literal into strings (null for NULL), nested for multi-dimensional arrays. */
const parseTextArray: TextParser = textParserFor(TEXT_ARRAY_OID);

function mapElements(parsed: unknown, convert: (element: string) => unknown): unknown {
  if (Array.isArray(parsed)) {
    return parsed.map((item: unknown) => mapElements(item, convert));
  }
  return typeof parsed === 'string' ? convert(parsed) : parsed;
}

function arrayOf(convert: (element: string) => unknown): TextParser {
  return (value) => mapElements(parseTextArray(value), convert);
}

const identity: TextParser = (value) => value;

const { builtins } = pg.types;

/**
 * Text-format parsers that return the value as Postgres sent it, or as exactly as a JS value can hold it: [scalar OID,
 * array OID, element parser]. Without these pg gives Dates (shifted by the host time zone, millisecond precision,
 * infinity as null), Buffers, objects for interval and geometric types, rounded floats for numeric[] and JSON numbers
 * a double cannot hold.
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
