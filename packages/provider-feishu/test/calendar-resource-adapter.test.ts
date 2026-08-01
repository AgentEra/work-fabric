import { describe, expect, it } from "vitest";

import * as provider from "../src/index.js";

type ResourceAdapter = {
  calendar(calendarId: string): string;
  event(calendarId: string, eventId: string): string;
  user(openId: string): string;
  chat(chatId: string): string;
  parseCalendar(resourceUri: string): { readonly calendar_id: string };
  parseEvent(resourceUri: string): {
    readonly calendar_id: string;
    readonly event_id: string;
  };
  parseUser(resourceUri: string): { readonly open_id: string };
  parseChat(resourceUri: string): { readonly chat_id: string };
};

type ResourceAdapterConstructor = new () => ResourceAdapter;

function constructor(): ResourceAdapterConstructor | undefined {
  const value = (provider as Record<string, unknown>)[
    "FeishuCalendarResourceAdapter"
  ];
  return typeof value === "function"
    ? value as ResourceAdapterConstructor
    : undefined;
}

describe("FeishuCalendarResourceAdapter", () => {
  it("round-trips canonical calendar, event, user and chat resources", () => {
    const Constructor = constructor();
    expect(Constructor).toBeTypeOf("function");
    if (Constructor === undefined) return;
    const resources = new Constructor();

    expect(resources.calendar("x@y")).toBe("feishu://calendar/x%40y");
    expect(resources.event("x@y", "event/1")).toBe(
      "feishu://calendar/x%40y/events/event%2F1",
    );
    expect(resources.user("ou/1")).toBe(
      "feishu://user/open-id/ou%2F1",
    );
    expect(resources.chat("oc/1")).toBe("feishu://chat/oc%2F1");
    expect(resources.parseCalendar(
      "feishu://calendar/x%40y",
    )).toEqual({ calendar_id: "x@y" });
    expect(resources.parseEvent(
      "feishu://calendar/x%40y/events/event%2F1",
    )).toEqual({ calendar_id: "x@y", event_id: "event/1" });
    expect(resources.parseUser(
      "feishu://user/open-id/ou%2F1",
    )).toEqual({ open_id: "ou/1" });
    expect(resources.parseChat(
      "feishu://chat/oc%2F1",
    )).toEqual({ chat_id: "oc/1" });
  });

  it.each([
    "feishu://user:secret@calendar/x",
    "feishu://calendar/x?raw=true",
    "feishu://calendar/x#fragment",
    "feishu://calendar/x%2540y",
    "feishu://calendar/x/events/e/extra",
    "feishu://user/open_id/ou_1",
    "https://calendar/x",
  ])("rejects non-canonical or unsupported resource %s", (resourceUri) => {
    const Constructor = constructor();
    if (Constructor === undefined) return;
    const resources = new Constructor();

    expect(() => {
      if (resourceUri.startsWith("feishu://calendar/") &&
          resourceUri.includes("/events/")) {
        resources.parseEvent(resourceUri);
      } else if (resourceUri.startsWith("feishu://calendar/")) {
        resources.parseCalendar(resourceUri);
      } else {
        resources.parseUser(resourceUri);
      }
    }).toThrow(/resource/i);
  });
});
