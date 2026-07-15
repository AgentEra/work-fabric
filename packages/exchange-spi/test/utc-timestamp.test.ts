import { describe, expect, it } from "vitest";

import {
  addUtcTimestampSeconds,
  compareUtcTimestamps,
  parseUtcTimestamp,
} from "../src/index.js";

describe("UTC timestamp helpers", () => {
  it("orders one nanosecond while normalizing equivalent fractions", () => {
    expect(
      compareUtcTimestamps(
        "2026-07-15T00:00:00.000000000Z",
        "2026-07-15T00:00:00.000000001Z",
      ),
    ).toBe(-1);
    expect(
      compareUtcTimestamps(
        "2026-07-15T00:00:00.1Z",
        "2026-07-15T00:00:00.100000000Z",
      ),
    ).toBe(0);
  });

  it("maps civil UTC time to exact epoch seconds across the Unix boundary", () => {
    expect(parseUtcTimestamp("1970-01-01T00:00:00Z").epoch_seconds).toBe(0n);
    expect(parseUtcTimestamp("1969-12-31T23:59:59Z").epoch_seconds).toBe(-1n);
  });

  it("adds whole seconds without changing the source fractional text", () => {
    expect(
      addUtcTimestampSeconds("2026-07-15T23:59:59.123456789Z", 2),
    ).toBe("2026-07-16T00:00:01.123456789Z");
    expect(addUtcTimestampSeconds("2026-07-15T23:59:59Z", 2)).toBe(
      "2026-07-16T00:00:01Z",
    );
    expect(addUtcTimestampSeconds("1999-12-31T23:59:59Z", 86_401)).toBe(
      "2000-01-02T00:00:00Z",
    );
  });

  it("rejects calendar-invalid and non-UTC input", () => {
    expect(() => parseUtcTimestamp("2026-02-29T00:00:00Z")).toThrow(
      /strict UTC/i,
    );
    expect(() => parseUtcTimestamp("2026-07-15T00:00:00+00:00")).toThrow(
      /strict UTC/i,
    );
    expect(parseUtcTimestamp("2000-02-29T00:00:00Z")).toMatchObject({
      nanoseconds: 0,
    });
    expect(() => parseUtcTimestamp("1900-02-29T00:00:00Z")).toThrow(
      /strict UTC/i,
    );
  });
});
