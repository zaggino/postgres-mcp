const EXPONENT_NOTATION_BELOW = -4;
const EXPONENT_NOTATION_FROM = 16;
const MIN_EXPONENT_DIGITS = 2;
const NATURAL_SIZE_SUFFIXES = ['kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'] as const;
const BYTES_BASE = 1000;

/** Python's `f"{value:.{digits}f}"`, including its spelling of non-finite values. */
export function formatFixed(value: number, digits: number): string {
  if (Number.isNaN(value)) {
    return 'nan';
  }
  if (!Number.isFinite(value)) {
    return value > 0 ? 'inf' : '-inf';
  }
  return value.toFixed(digits);
}

/** Python's `f"{value:.2%}"`. */
export function formatPercent(value: number): string {
  return `${formatFixed(value * 100, 2)}%`;
}

/** `humanize.naturalsize` (decimal units): "1 Byte", "999 Bytes", "1.0 kB", "10.5 MB". */
export function naturalSize(value: number): string {
  const absolute = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (absolute === 1) {
    return `${sign}1 Byte`;
  }
  if (absolute < BYTES_BASE) {
    return `${sign}${Math.trunc(absolute)} Bytes`;
  }
  let exponent = 1;
  let unit = BYTES_BASE;
  while (exponent < NATURAL_SIZE_SUFFIXES.length && absolute >= unit * BYTES_BASE) {
    unit *= BYTES_BASE;
    exponent += 1;
  }
  const suffix = NATURAL_SIZE_SUFFIXES[exponent - 1] ?? '';
  return `${sign}${(absolute / unit).toFixed(1)} ${suffix}`;
}

/** Python's `str(type(value))` for a parsed JSON value, used in user-facing error messages. */
export function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) {
    return "<class 'NoneType'>";
  }
  if (Array.isArray(value)) {
    return "<class 'list'>";
  }
  // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- every other typeof is reported as dict, as upstream does
  switch (typeof value) {
    case 'string': {
      return "<class 'str'>";
    }
    case 'boolean': {
      return "<class 'bool'>";
    }
    case 'number': {
      return Number.isInteger(value) ? "<class 'int'>" : "<class 'float'>";
    }
    default: {
      return "<class 'dict'>";
    }
  }
}

/** Python's `str(float)` / `repr(float)`: shortest round-trip digits, Python's notation thresholds. */
export function pyFloatStr(value: number): string {
  if (Number.isNaN(value)) {
    return 'nan';
  }
  if (!Number.isFinite(value)) {
    return value > 0 ? 'inf' : '-inf';
  }
  if (value === 0) {
    return Object.is(value, -0) ? '-0.0' : '0.0';
  }
  const sign = value < 0 ? '-' : '';
  const [mantissa = '', exponentText = '0'] = Math.abs(value).toExponential().split('e');
  const exponent = Number(exponentText);
  const digits = mantissa.replace('.', '');

  if (exponent < EXPONENT_NOTATION_BELOW || exponent >= EXPONENT_NOTATION_FROM) {
    const head = digits.length > 1 ? `${digits.slice(0, 1)}.${digits.slice(1)}` : digits;
    const expSign = exponent < 0 ? '-' : '+';
    const expDigits = String(Math.abs(exponent)).padStart(MIN_EXPONENT_DIGITS, '0');
    return `${sign}${head}e${expSign}${expDigits}`;
  }
  if (exponent < 0) {
    return `${sign}0.${'0'.repeat(-exponent - 1)}${digits}`;
  }
  const intLength = exponent + 1;
  if (digits.length <= intLength) {
    return `${sign}${digits.padEnd(intLength, '0')}.0`;
  }
  return `${sign}${digits.slice(0, intLength)}.${digits.slice(intLength)}`;
}
