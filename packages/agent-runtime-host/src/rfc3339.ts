import { invalid } from "./errors.js";

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-](\d{2}):(\d{2}))$/;

export interface Rfc3339Timestamp {
  readonly canonical: string;
  readonly epoch_seconds: bigint;
  readonly nanoseconds: bigint;
}

function leapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function parseRfc3339(value: unknown, path: string, code = "invalid_timestamp"): Rfc3339Timestamp {
  if (typeof value !== "string") invalid(code, path);
  const match = RFC3339.exec(value);
  if (match === null) invalid(code, path);
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const hour = Number(match[4]); const minute = Number(match[5]); const second = Number(match[6]);
  const offsetHour = Number(match[9] ?? 0); const offsetMinute = Number(match[10] ?? 0);
  const days = [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]! || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) invalid(code, path);
  const localEpoch = Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`);
  if (!Number.isFinite(localEpoch)) invalid(code, path);
  const offsetSeconds = BigInt((offsetHour * 60 + offsetMinute) * 60);
  const epochSeconds = BigInt(Math.trunc(localEpoch / 1_000)) + (match[8] === "Z" || match[8]!.startsWith("-") ? offsetSeconds : -offsetSeconds);
  const nanoseconds = BigInt((match[7] ?? "").padEnd(9, "0") || "0");
  const utc = new Date(Number(epochSeconds) * 1_000).toISOString().slice(0, 19);
  const fraction = nanoseconds === 0n ? "" : `.${nanoseconds.toString().padStart(9, "0").replace(/0+$/, "")}`;
  return { canonical: `${utc}${fraction}Z`, epoch_seconds: epochSeconds, nanoseconds };
}

export function normalizeRfc3339(value: unknown, path: string, code = "invalid_timestamp"): string {
  return parseRfc3339(value, path, code).canonical;
}

export function compareRfc3339(left: Rfc3339Timestamp, right: Rfc3339Timestamp): number {
  if (left.epoch_seconds !== right.epoch_seconds) return left.epoch_seconds < right.epoch_seconds ? -1 : 1;
  if (left.nanoseconds !== right.nanoseconds) return left.nanoseconds < right.nanoseconds ? -1 : 1;
  return 0;
}
