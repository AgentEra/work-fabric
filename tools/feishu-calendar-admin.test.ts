import { describe, expect, it } from "vitest";

import { parseFeishuCalendarAdminArguments } from "./feishu-calendar-admin.js";

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
});
