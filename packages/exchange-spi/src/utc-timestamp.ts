const STRICT_UTC_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

export interface ParsedUtcTimestamp {
  readonly epoch_seconds: bigint;
  readonly nanoseconds: number;
  readonly fraction: string | null;
}

function invalid(label: string): TypeError {
  return new TypeError(`${label} must be a strict UTC ISO timestamp`);
}

function floorDivide(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor;
  return value < 0n && value % divisor !== 0n ? quotient - 1n : quotient;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return new Set([4, 6, 9, 11]).has(month) ? 30 : 31;
}

function daysFromCivil(year: number, month: number, day: number): bigint {
  const adjustedYear = BigInt(year - (month <= 2 ? 1 : 0));
  const era = floorDivide(adjustedYear, 400n);
  const yearOfEra = adjustedYear - era * 400n;
  const monthPrime = BigInt(month + (month > 2 ? -3 : 9));
  const dayOfYear = (153n * monthPrime + 2n) / 5n + BigInt(day - 1);
  const dayOfEra =
    yearOfEra * 365n +
    yearOfEra / 4n -
    yearOfEra / 100n +
    dayOfYear;
  return era * 146_097n + dayOfEra - 719_468n;
}

function civilFromDays(daysSinceEpoch: bigint): {
  readonly year: number;
  readonly month: number;
  readonly day: number;
} {
  const shifted = daysSinceEpoch + 719_468n;
  const era = floorDivide(shifted, 146_097n);
  const dayOfEra = shifted - era * 146_097n;
  const yearOfEra =
    (dayOfEra -
      dayOfEra / 1_460n +
      dayOfEra / 36_524n -
      dayOfEra / 146_096n) /
    365n;
  let year = yearOfEra + era * 400n;
  const dayOfYear =
    dayOfEra -
    (365n * yearOfEra + yearOfEra / 4n - yearOfEra / 100n);
  const monthPrime = (5n * dayOfYear + 2n) / 153n;
  const day = dayOfYear - (153n * monthPrime + 2n) / 5n + 1n;
  const month = monthPrime + (monthPrime < 10n ? 3n : -9n);
  if (month <= 2n) year += 1n;
  if (year < 0n || year > 9_999n) throw new RangeError("timestamp overflow");
  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
  };
}

export function parseUtcTimestamp(
  value: unknown,
  label = "timestamp",
): ParsedUtcTimestamp {
  const match =
    typeof value === "string" ? STRICT_UTC_TIMESTAMP.exec(value) : null;
  if (match === null) throw invalid(label);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw invalid(label);
  }

  const fraction = match[7] ?? null;
  return {
    epoch_seconds:
      daysFromCivil(year, month, day) * 86_400n +
      BigInt(hour * 3_600 + minute * 60 + second),
    nanoseconds: fraction === null ? 0 : Number(fraction.padEnd(9, "0")),
    fraction,
  };
}

export function compareUtcTimestamps(left: string, right: string): -1 | 0 | 1 {
  const leftInstant = parseUtcTimestamp(left, "left timestamp");
  const rightInstant = parseUtcTimestamp(right, "right timestamp");
  if (leftInstant.epoch_seconds < rightInstant.epoch_seconds) return -1;
  if (leftInstant.epoch_seconds > rightInstant.epoch_seconds) return 1;
  if (leftInstant.nanoseconds < rightInstant.nanoseconds) return -1;
  if (leftInstant.nanoseconds > rightInstant.nanoseconds) return 1;
  return 0;
}

export function addUtcTimestampSeconds(
  timestamp: string,
  seconds: number,
): string {
  const parsed = parseUtcTimestamp(timestamp);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new RangeError("seconds must be a positive safe integer");
  }
  const totalSeconds = parsed.epoch_seconds + BigInt(seconds);
  const daysSinceEpoch = floorDivide(totalSeconds, 86_400n);
  const secondsWithinDay = totalSeconds - daysSinceEpoch * 86_400n;
  const civil = civilFromDays(daysSinceEpoch);
  const hour = secondsWithinDay / 3_600n;
  const minute = (secondsWithinDay % 3_600n) / 60n;
  const second = secondsWithinDay % 60n;
  const wholeSeconds = `${String(civil.year).padStart(4, "0")}-${String(
    civil.month,
  ).padStart(2, "0")}-${String(civil.day).padStart(2, "0")}T${String(
    hour,
  ).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(
    second,
  ).padStart(2, "0")}`;
  const result = `${wholeSeconds}${
    parsed.fraction === null ? "" : `.${parsed.fraction}`
  }Z`;
  parseUtcTimestamp(result, "calculated timestamp");
  return result;
}
