import type { CustomTypesConfig } from 'pg';
import pg from 'pg';

import { parseJsonLossless } from '../json.ts';

const INT8_OID = 20;
const BYTEA_OID = 17;
const JSON_OID = 114;
const JSON_ARRAY_OID = 199;
const POINT_OID = 600;
const CIRCLE_OID = 718;
const CIRCLE_ARRAY_OID = 719;
const DATE_OID = 1082;
const TIMESTAMP_OID = 1114;
const TIMESTAMPTZ_OID = 1184;
const INTERVAL_OID = 1186;
const BYTEA_ARRAY_OID = 1001;
const INT8_ARRAY_OID = 1016;
const POINT_ARRAY_OID = 1017;
const TEXT_ARRAY_OID = 1009;
const DATE_ARRAY_OID = 1182;
const TIMESTAMP_ARRAY_OID = 1115;
const TIMESTAMPTZ_ARRAY_OID = 1185;
const INTERVAL_ARRAY_OID = 1187;
const NUMERIC_ARRAY_OID = 1231;
const JSONB_OID = 3802;
const JSONB_ARRAY_OID = 3807;

type TextParser = (value: string) => unknown;

function parseInt8(value: string): number | bigint {
  const asNumber = Number(value);
  return Number.isSafeInteger(asNumber) ? asNumber : BigInt(value);
}

// pg types the OID as an enum and the parser as any; the OID is a plain number here.
const textParserFor = pg.types.getTypeParser as (oid: number, format: 'text') => TextParser;

/** Parses a text[] literal into strings (null for NULL), nested for multi-dimensional arrays. */
const parseTextArray: TextParser = textParserFor(TEXT_ARRAY_OID, 'text');

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

/**
 * Text-format parsers that return the value as Postgres sent it, or as exactly as a JS value can hold it. Without
 * these pg gives Dates (shifted by the host time zone, millisecond precision, infinity as null), Buffers, objects
 * for interval and geometric types, rounded floats for numeric[] and JSON numbers a double cannot hold.
 */
const TEXT_PARSERS = new Map<number, TextParser>([
  [DATE_OID, identity],
  [TIMESTAMP_OID, identity],
  [TIMESTAMPTZ_OID, identity],
  [BYTEA_OID, identity],
  [INTERVAL_OID, identity],
  [POINT_OID, identity],
  [CIRCLE_OID, identity],
  [DATE_ARRAY_OID, parseTextArray],
  [TIMESTAMP_ARRAY_OID, parseTextArray],
  [TIMESTAMPTZ_ARRAY_OID, parseTextArray],
  [BYTEA_ARRAY_OID, parseTextArray],
  [INTERVAL_ARRAY_OID, parseTextArray],
  [POINT_ARRAY_OID, parseTextArray],
  [CIRCLE_ARRAY_OID, parseTextArray],
  [NUMERIC_ARRAY_OID, parseTextArray],
  [INT8_OID, parseInt8],
  [INT8_ARRAY_OID, arrayOf(parseInt8)],
  [JSON_OID, parseJsonLossless],
  [JSONB_OID, parseJsonLossless],
  [JSON_ARRAY_OID, arrayOf(parseJsonLossless)],
  [JSONB_ARRAY_OID, arrayOf(parseJsonLossless)],
]);

export const customTypes: CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') => {
    if ((format ?? 'text') === 'text') {
      const parser = TEXT_PARSERS.get(oid);
      if (parser) {
        return parser;
      }
    }
    // oxlint-disable-next-line typescript/no-unsafe-return, typescript/no-unsafe-enum-assignment -- pg types the OID as an enum and the parser as any
    return pg.types.getTypeParser(oid, format);
  }) as CustomTypesConfig['getTypeParser'],
};
