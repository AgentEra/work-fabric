import { invalid } from "./errors.js";

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/;

function leapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function normalizeRfc3339(value: unknown, path: string, code = "invalid_timestamp"): string {
  if (typeof value !== "string") invalid(code, path);
  const match = RFC3339.exec(value);
  if (match === null) invalid(code, path);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[7] ?? 0);
  const offsetMinute = Number(match[8] ?? 0);
  const days = [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]! || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) invalid(code, path);
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) invalid(code, path);
  return new Date(epoch).toISOString();
}
