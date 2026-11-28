/** A parsed JSON object (not an array). */
export type JsonObject = Readonly<Record<string, unknown>>;

/** True for a plain parsed JSON object; false for arrays and for raw JSON values (see parseJsonLossless). */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !JSON.isRawJSON(value);
}

interface RawJSON {
  readonly rawJSON: string;
}

// The ES2024 lib lacks these (Node has them at runtime); delete the augmentation once `lib` includes them.
declare global {
  interface JSON {
    rawJSON: (text: string) => RawJSON;
    isRawJSON: (value: unknown) => value is RawJSON;
    // oxlint-disable-next-line typescript/method-signature-style -- an overload of JSON.parse needs method syntax, a property would clash with the lib's
    parse(
      text: string,
      reviver: (this: unknown, key: string, value: unknown, context: { source?: string }) => unknown
    ): unknown;
  }
}

const NUMBER_TEXT = /^(?<sign>-?)(?<int>\d*)(?:\.(?<frac>\d*))?(?:[eE](?<exp>[+-]?\d+))?$/u;

/** A decimal number's sign, significant digits (no leading or trailing zeros) and exponent, so equal values compare equal. */
function normalizeDecimal(text: string): string {
  const groups = NUMBER_TEXT.exec(text)?.groups;
  if (!groups) {
    return text;
  }
  const frac = groups.frac ?? '';
  const digits = `${groups.int ?? ''}${frac}`;
  const stripped = digits.replace(/^0+/u, '');
  const significant = stripped.replace(/0+$/u, '');
  if (significant === '') {
    return '0';
  }
  const exponent = Number(groups.exp ?? '0') - frac.length + (stripped.length - significant.length);
  return `${groups.sign ?? ''}${significant}e${exponent}`;
}

/**
 * JSON.parse that keeps the source digits of a number a double cannot write back. pg's own parse rounds those
 * (integers beyond 2^53, 1e400, long decimals). A number stays a JS number when the double's shortest round-trip
 * decimal equals the source's value, so `toJson` writes the same value; otherwise it is kept as a raw JSON value
 * (an object, not a number) that `toJson` writes back with its source digits. Code that does arithmetic on the result
 * must convert raw values first (see `parsePlanColumn` in `src/explain/explain-plan.ts`). Value-equal numbers are
 * written in their shortest form: `12.50` comes back as `12.5` and `-0` as `0`.
 */
export function parseJsonLossless(text: string): unknown {
  return JSON.parse(text, (_key, value, context) => {
    const { source } = context;
    if (typeof value === 'number' && source !== undefined) {
      const exact = Number.isFinite(value) && normalizeDecimal(source) === normalizeDecimal(String(value));
      return exact ? value : JSON.rawJSON(source);
    }
    return value;
  });
}

/**
 * Tool output as JSON. A bigint is written as an exact JSON number; NaN and the infinities, which JSON has no number
 * for, as the strings "NaN", "Infinity" and "-Infinity". Raw JSON values (see parseJsonLossless) pass through.
 */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') {
      return JSON.rawJSON(item.toString());
    }
    return typeof item === 'number' && !Number.isFinite(item) ? String(item) : item;
  });
}
