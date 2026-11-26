const EXPONENT_NOTATION_BELOW = -4;
const EXPONENT_NOTATION_FROM = 16;
const MIN_EXPONENT_DIGITS = 2;

/** Python's `str(float)` / `repr(float)`: shortest round-trip digits, Python's notation thresholds. */
export function pyFloatStr(value: number): string {
  if (Number.isNaN(value)) {
    return "nan";
  }
  if (!Number.isFinite(value)) {
    return value > 0 ? "inf" : "-inf";
  }
  if (value === 0) {
    return Object.is(value, -0) ? "-0.0" : "0.0";
  }
  const sign = value < 0 ? "-" : "";
  const [mantissa = "", exponentText = "0"] = Math.abs(value)
    .toExponential()
    .split("e");
  const exponent = Number(exponentText);
  const digits = mantissa.replace(".", "");

  if (
    exponent < EXPONENT_NOTATION_BELOW ||
    exponent >= EXPONENT_NOTATION_FROM
  ) {
    const head =
      digits.length > 1 ? `${digits.slice(0, 1)}.${digits.slice(1)}` : digits;
    const expSign = exponent < 0 ? "-" : "+";
    const expDigits = String(Math.abs(exponent)).padStart(
      MIN_EXPONENT_DIGITS,
      "0"
    );
    return `${sign}${head}e${expSign}${expDigits}`;
  }
  if (exponent < 0) {
    return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
  }
  const intLength = exponent + 1;
  if (digits.length <= intLength) {
    return `${sign}${digits.padEnd(intLength, "0")}.0`;
  }
  return `${sign}${digits.slice(0, intLength)}.${digits.slice(intLength)}`;
}
