/** A parsed JSON object (not an array). */
export type JsonObject = Readonly<Record<string, unknown>>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The ES2024 lib has no type for JSON.rawJSON, which Node has at runtime; the reviver's source context is typed
// locally as ReviverContext below.
declare global {
  interface JSON {
    rawJSON: (text: string) => object;
  }
}

const NUMBER_TEXT = /^(?<sign>-?)(?<int>\d*)(?:\.(?<frac>\d*))?(?:[eE](?<exp>[+-]?\d+))?$/u;

/** A decimal number's sign, significant digits (no leading or trailing zeros) and exponent, so equal values compare equal. */
function normalizeDecimal(text: string): string {
  const groups = NUMBER_TEXT.exec(text)?.groups;
  if (!groups) {
    return text;
  }
  const int = groups.int ?? '';
  const frac = groups.frac ?? '';
  const digits = `${int}${frac}`;
  const leading = digits.length - digits.replace(/^0+/u, '').length;
  const significant = digits.slice(leading).replace(/0+$/u, '');
  if (significant === '') {
    return '0';
  }
  const trailing = digits.slice(leading).length - significant.length;
  const exponent = Number(groups.exp ?? '0') - frac.length + trailing;
  return `${groups.sign ?? ''}${significant}e${exponent}`;
}

interface ReviverContext {
  source?: string;
}

/**
 * JSON.parse that keeps the source digits of a number a double cannot hold. pg's own parse rounds those (integers
 * beyond 2^53, 1e400, long decimals); here each becomes a raw JSON value that `toJson` writes back unchanged. Numbers
 * a double represents exactly (by decimal value, so `12.50` and `1e2` qualify) stay plain numbers.
 */
export function parseJsonLossless(text: string): unknown {
  return JSON.parse(text, ((_key: string, value: unknown, context?: ReviverContext) => {
    const source = context?.source;
    if (typeof value === 'number' && source !== undefined) {
      const exact = Number.isFinite(value) && normalizeDecimal(source) === normalizeDecimal(String(value));
      return exact ? value : JSON.rawJSON(source);
    }
    return value;
  }) as Parameters<typeof JSON.parse>[1]);
}
