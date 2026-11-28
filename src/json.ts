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

/**
 * JSON.parse that keeps every number as a raw JSON value holding its source text, so `toJson` writes it back exactly
 * as Postgres sent it; pg's own parse rounds what a double cannot hold (integers beyond 2^53, 1e400, long decimals).
 * A number in the result is therefore never a JS number: code that does arithmetic on it re-parses with plain
 * JSON.parse first (see `parsePlanColumn` in `src/explain/explain-plan.ts`).
 */
export function parseJsonLossless(text: string): unknown {
  return JSON.parse(text, (_key, value, { source }) =>
    typeof value === 'number' && source !== undefined ? JSON.rawJSON(source) : value
  );
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
