import { describe, expect, it } from "vitest";

import * as provider from "../src/index.js";
import {
  calendarStoreContract,
  type CalendarStore,
} from "./calendar-store-contract.js";

type Constructor = new () => CalendarStore;

function constructor(): Constructor | undefined {
  const value = (provider as Record<string, unknown>)[
    "MemoryFeishuCalendarStore"
  ];
  return typeof value === "function" ? value as Constructor : undefined;
}

describe("MemoryFeishuCalendarStore", () => {
  it("is exposed as a separate Calendar-owned state adapter", () => {
    expect(constructor()).toBeTypeOf("function");
  });
});

calendarStoreContract("memory", async () => {
  const Constructor = constructor();
  if (Constructor === undefined) {
    throw new TypeError("MemoryFeishuCalendarStore is unavailable");
  }
  return new Constructor();
});
