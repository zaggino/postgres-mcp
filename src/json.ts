/** A parsed JSON object (not an array). */
export type JsonObject = Readonly<Record<string, unknown>>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
