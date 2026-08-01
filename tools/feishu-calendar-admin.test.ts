import { describe, expect, it, vi } from "vitest";

import {
  listCalendarBindings,
  parseFeishuCalendarAdminArguments,
} from "./feishu-calendar-admin.js";

describe("Feishu Calendar admin CLI", () => {
  it("strictly parses bind, create and list commands", () => {
    expect(parseFeishuCalendarAdminArguments([
      "bind-existing",
      "--alias",
      "team",
      "--calendar-id",
      "cal-1",
      "--default",
    ])).toEqual({
      command: "bind-existing",
      alias: "team",
      calendar_id: "cal-1",
      make_default: true,
    });
    expect(parseFeishuCalendarAdminArguments([
      "create-and-bind",
      "--alias",
      "team",
      "--summary",
      "团队协作日历",
      "--permissions",
      "show_only_free_busy",
    ])).toEqual({
      command: "create-and-bind",
      alias: "team",
      summary: "团队协作日历",
      permissions: "show_only_free_busy",
      make_default: false,
    });
    expect(parseFeishuCalendarAdminArguments(["list"])).toEqual({
      command: "list",
    });
  });

  it("rejects unknown flags, secret flags and incomplete commands", () => {
    expect(() => parseFeishuCalendarAdminArguments([
      "bind-existing",
      "--app-secret",
      "forbidden",
    ])).toThrow();
    expect(() => parseFeishuCalendarAdminArguments([
      "create-and-bind",
      "--alias",
      "team",
    ])).toThrow();
    expect(() => parseFeishuCalendarAdminArguments([
      "list",
      "--default",
    ])).toThrow();
  });

  it("lists bindings through bounded SPI pages", async () => {
    const listBindings = vi.fn()
      .mockResolvedValueOnce({
        items: [{ alias: "a" }],
        next_after_alias: "a",
      })
      .mockResolvedValueOnce({
        items: [{ alias: "b" }],
        next_after_alias: null,
      });

    await expect(listCalendarBindings(
      { listBindings } as never,
      "tenant-1",
    )).resolves.toEqual([{ alias: "a" }, { alias: "b" }]);
    expect(listBindings).toHaveBeenNthCalledWith(1, {
      tenant_id: "tenant-1",
      limit: 100,
    });
    expect(listBindings).toHaveBeenNthCalledWith(2, {
      tenant_id: "tenant-1",
      after_alias: "a",
      limit: 100,
    });
  });
});
