import { describe, expect, it, vi } from "vitest";

import {
  FeishuOpenApiRequestClient,
  FeishuProviderBackendError,
} from "../src/index.js";
import * as provider from "../src/index.js";

type RequestClient = {
  request(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>;
};

type Backend = {
  getCalendar(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  createSharedCalendar(
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  queryFreeBusy(
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  listPrimaryEvents(
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  createEvent(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  readEvent(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  updateEvent(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  addAttendees(
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  removeAttendees(
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  deleteEvent(input: Record<string, unknown>): Promise<Record<string, unknown>>;
};

type BackendConstructor = new (input: {
  readonly requests: RequestClient;
  readonly now?: () => string;
  readonly maximum_concurrency?: number;
}) => Backend;

function constructor(): BackendConstructor | undefined {
  const value = (provider as Record<string, unknown>)[
    "FeishuCalendarOpenApiBackend"
  ];
  return typeof value === "function"
    ? value as BackendConstructor
    : undefined;
}

function event(eventId = "event-1") {
  return {
    event_id: eventId,
    summary: "项目评审",
    description: "第一阶段",
    start_time: {
      timestamp: "1785366000",
      timezone: "Asia/Shanghai",
    },
    end_time: {
      timestamp: "1785369600",
      timezone: "Asia/Shanghai",
    },
    visibility: "public",
    attendee_ability: "can_invite_others",
    event_organizer: { organizer_id: "ou-bot" },
    create_time: "1785360000",
    update_time: "1785360100",
    app_link: `https://feishu.example/calendar/${eventId}`,
  };
}

describe("FeishuCalendarOpenApiBackend", () => {
  it("is exposed as an independent bounded Calendar backend", () => {
    expect(constructor()).toBeTypeOf("function");
  });

  it("maps calendar administration and chunked free/busy in original user order", async () => {
    const Constructor = constructor();
    if (Constructor === undefined) return;
    const calls: Array<{
      readonly method: string;
      readonly path: string;
      readonly body?: unknown;
    }> = [];
    const request = vi.fn(async (
      method: string,
      path: string,
      body?: unknown,
    ) => {
      calls.push(body === undefined
        ? { method, path }
        : { method, path, body });
      if (method === "GET") {
        return {
          code: 0,
          data: {
            calendar: {
              calendar_id: "cal-1",
              summary: "团队日历",
              description: "项目协作",
              type: "shared",
              role: "owner",
            },
          },
        };
      }
      if (path === "/open-apis/calendar/v4/calendars") {
        return {
          code: 0,
          data: {
            calendar: {
              calendar_id: "cal-created",
              summary: "新团队日历",
              description: "项目协作",
              type: "shared",
              role: "owner",
            },
          },
        };
      }
      const ids = (body as { user_ids: string[] }).user_ids;
      return {
        code: 0,
        data: {
          freebusy_lists: [...ids].reverse().map((userId) => ({
            user_id: userId,
            freebusy_items: [{
              start_time: "2026-07-30T09:00:00+08:00",
              end_time: "2026-07-30T09:30:00+08:00",
            }],
          })),
        },
      };
    });
    const backend = new Constructor({
      requests: { request },
      maximum_concurrency: 3,
      now: () => "2026-07-29T12:00:00.000Z",
    });

    await expect(backend.getCalendar({
      calendar_id: "cal-1",
    })).resolves.toEqual({
      calendar_id: "cal-1",
      summary: "团队日历",
      description: "项目协作",
      calendar_type: "shared",
      access_role: "owner",
    });
    await expect(backend.createSharedCalendar({
      summary: "新团队日历",
      description: "项目协作",
    })).resolves.toMatchObject({
      calendar_id: "cal-created",
      calendar_type: "shared",
      access_role: "owner",
    });
    const users = Array.from({ length: 11 }, (_, index) => `ou_${index}`);
    await expect(backend.queryFreeBusy({
      user_open_ids: users,
      start_at: "2026-07-30T09:00:00+08:00",
      end_at: "2026-07-30T18:00:00+08:00",
      include_external_calendars: false,
      busy_only: true,
    })).resolves.toMatchObject({
      start_at: "2026-07-30T09:00:00+08:00",
      end_at: "2026-07-30T18:00:00+08:00",
      participants: users.map((openId) => ({
        open_id: openId,
        busy_intervals: [{
          start_at: "2026-07-30T09:00:00+08:00",
          end_at: "2026-07-30T09:30:00+08:00",
        }],
      })),
      unresolved: [],
    });
    expect(calls).toEqual([
      {
        method: "GET",
        path: "/open-apis/calendar/v4/calendars/cal-1",
      },
      {
        method: "POST",
        path: "/open-apis/calendar/v4/calendars",
        body: {
          summary: "新团队日历",
          description: "项目协作",
          permissions: "private",
        },
      },
      {
        method: "POST",
        path:
          "/open-apis/calendar/v4/freebusy/batch?user_id_type=open_id",
        body: {
          time_min: "2026-07-30T09:00:00+08:00",
          time_max: "2026-07-30T18:00:00+08:00",
          user_ids: users.slice(0, 10),
          include_external_calendar: false,
          only_busy: true,
        },
      },
      {
        method: "POST",
        path:
          "/open-apis/calendar/v4/freebusy/batch?user_id_type=open_id",
        body: {
          time_min: "2026-07-30T09:00:00+08:00",
          time_max: "2026-07-30T18:00:00+08:00",
          user_ids: users.slice(10),
          include_external_calendar: false,
          only_busy: true,
        },
      },
    ]);
  });

  it("treats an omitted busy list as every requested user being free", async () => {
    const Constructor = constructor();
    if (Constructor === undefined) return;
    const backend = new Constructor({
      requests: {
        request: vi.fn(async () => ({ code: 0, data: {} })),
      },
    });

    await expect(backend.queryFreeBusy({
      user_open_ids: ["ou_1", "ou_2"],
      start_at: "2026-07-31T14:00:00+08:00",
      end_at: "2026-07-31T17:00:00+08:00",
      include_external_calendars: false,
      busy_only: true,
    })).resolves.toEqual({
      start_at: "2026-07-31T14:00:00+08:00",
      end_at: "2026-07-31T17:00:00+08:00",
      participants: [
        { open_id: "ou_1", busy_intervals: [] },
        { open_id: "ou_2", busy_intervals: [] },
      ],
      unresolved: [],
    });
  });

  it("lists a bounded primary-calendar page with explicit redaction and all-day facts", async () => {
    const Constructor = constructor();
    if (Constructor === undefined) return;
    const calls: Array<{
      readonly method: string;
      readonly path: string;
      readonly body?: unknown;
    }> = [];
    const request = vi.fn(async (
      method: string,
      path: string,
      body?: unknown,
    ) => {
      calls.push(body === undefined
        ? { method, path }
        : { method, path, body });
      if (path.startsWith(
        "/open-apis/calendar/v4/calendars/primarys",
      )) {
        return {
          code: 0,
          data: {
            calendars: [{
              user_id: "ou_1",
              calendar: {
                calendar_id: "cal-primary-1",
                type: "primary",
                role: "free_busy_reader",
              },
            }],
          },
        };
      }
      return {
        code: 0,
        data: {
          has_more: true,
          page_token: "next-page",
          items: [
            {
              event_id: "event-redacted",
              summary: "",
              start_time: {
                timestamp: "1785366000",
                timezone: "Asia/Shanghai",
              },
              end_time: {
                timestamp: "1785369600",
                timezone: "Asia/Shanghai",
              },
              status: "confirmed",
            },
            {
              event_id: "event-all-day",
              summary: "项目里程碑",
              description: "阶段交付",
              start_time: { date: "2026-07-31" },
              end_time: { date: "2026-08-01" },
              visibility: "public",
              app_link: "https://feishu.example/calendar/event-all-day",
              event_organizer: { user_id: "ou_organizer" },
            },
          ],
        },
      };
    });
    const backend = new Constructor({ requests: { request } });

    await expect(backend.listPrimaryEvents({
      user_open_id: "ou_1",
      start_at: "2026-07-31T00:00:00+08:00",
      end_at: "2026-08-03T00:00:00+08:00",
      page_size: 25,
      page_token: "current-page",
    })).resolves.toEqual({
      calendar_id: "cal-primary-1",
      access_role: "free_busy_reader",
      events: [
        {
          event_id: "event-redacted",
          start: {
            kind: "date_time",
            at: "2026-07-29T23:00:00.000Z",
            time_zone: "Asia/Shanghai",
          },
          end: {
            kind: "date_time",
            at: "2026-07-30T00:00:00.000Z",
            time_zone: "Asia/Shanghai",
          },
          status: "confirmed",
          details_visible: false,
        },
        {
          event_id: "event-all-day",
          title: "项目里程碑",
          description: "阶段交付",
          start: { kind: "all_day", date: "2026-07-31" },
          end: { kind: "all_day", date: "2026-08-01" },
          visibility: "public",
          url: "https://feishu.example/calendar/event-all-day",
          organizer_open_id: "ou_organizer",
          details_visible: true,
        },
      ],
      has_more: true,
      next_page_token: "next-page",
    });
    expect(calls[0]).toEqual({
      method: "POST",
      path:
        "/open-apis/calendar/v4/calendars/primarys?user_id_type=open_id",
      body: { user_ids: ["ou_1"] },
    });
    const eventCall = calls[1]!;
    expect(eventCall.method).toBe("GET");
    const url = new URL(`https://open.feishu.test${eventCall.path}`);
    expect(url.pathname).toBe(
      "/open-apis/calendar/v4/calendars/cal-primary-1/events",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      user_id_type: "open_id",
      op_user_id: "ou_1",
      start_time: "1785427200",
      end_time: "1785686400",
      page_size: "25",
      page_token: "current-page",
    });
  });

  it("maps event CRUD and attendee endpoints with explicit notification", async () => {
    const Constructor = constructor();
    if (Constructor === undefined) return;
    const calls: Array<{
      readonly method: string;
      readonly path: string;
      readonly body?: unknown;
    }> = [];
    const request = vi.fn(async (
      method: string,
      path: string,
      body?: unknown,
    ) => {
      calls.push(body === undefined
        ? { method, path }
        : { method, path, body });
      if (path.endsWith("/attendees")) {
        return {
          code: 0,
          data: {
            attendees: [{
              type: "user",
              attendee_id: "ou_1",
              is_optional: false,
            }],
          },
        };
      }
      if (method === "DELETE") return { code: 0, data: {} };
      return { code: 0, data: { event: event() } };
    });
    const backend = new Constructor({
      requests: { request },
      now: () => "2026-07-29T12:00:00.000Z",
    });
    const base = {
      calendar_id: "cal-1",
      event_id: "event-1",
    };

    await expect(backend.createEvent({
      calendar_id: "cal-1",
      title: "项目评审",
      description: "第一阶段",
      start_at: "2026-07-30T09:00:00+08:00",
      end_at: "2026-07-30T10:00:00+08:00",
      time_zone: "Asia/Shanghai",
      visibility: "public",
      attendee_ability: "can_invite_others",
      reminders: [10],
      idempotency_key: "work-fabric-create-1",
    })).resolves.toMatchObject({
      calendar_id: "cal-1",
      event_id: "event-1",
      title: "项目评审",
      time_zone: "Asia/Shanghai",
      url: "https://feishu.example/calendar/event-1",
      updated_at: "2026-07-29T21:21:40.000Z",
    });
    await expect(backend.readEvent(base)).resolves.toMatchObject({
      event_id: "event-1",
    });
    await expect(backend.updateEvent({
      ...base,
      field_mask: ["title"],
      changes: { title: "终审" },
    })).resolves.toMatchObject({
      event_id: "event-1",
    });
    await expect(backend.addAttendees({
      ...base,
      attendees: [{ kind: "user", open_id: "ou_1" }],
      need_notification: true,
    })).resolves.toEqual({
      attendees: [{
        kind: "user",
        external_id: "ou_1",
        outcome: "added",
      }],
    });
    await expect(backend.removeAttendees({
      ...base,
      attendees: [{ kind: "user", open_id: "ou_1" }],
      need_notification: false,
    })).resolves.toEqual({
      attendees: [{
        kind: "user",
        external_id: "ou_1",
        outcome: "removed",
      }],
    });
    await expect(backend.deleteEvent({
      ...base,
      need_notification: true,
    })).resolves.toEqual({
      calendar_id: "cal-1",
      event_id: "event-1",
      deleted_at: "2026-07-29T12:00:00.000Z",
    });

    const create = calls[0]!;
    expect(create.method).toBe("POST");
    const createUrl = new URL(`https://open.feishu.test${create.path}`);
    expect(createUrl.pathname).toBe(
      "/open-apis/calendar/v4/calendars/cal-1/events",
    );
    expect(createUrl.searchParams.get("user_id_type")).toBe("open_id");
    expect(createUrl.searchParams.get("idempotency_key")).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(create.body).toEqual({
      summary: "项目评审",
      description: "第一阶段",
      start_time: {
        timestamp: String(
          Math.floor(Date.parse("2026-07-30T09:00:00+08:00") / 1_000),
        ),
        timezone: "Asia/Shanghai",
      },
      end_time: {
        timestamp: String(
          Math.floor(Date.parse("2026-07-30T10:00:00+08:00") / 1_000),
        ),
        timezone: "Asia/Shanghai",
      },
      visibility: "public",
      attendee_ability: "can_invite_others",
      reminders: [{ minutes: 10 }],
    });
    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ["POST", expect.stringMatching(
        /^\/open-apis\/calendar\/v4\/calendars\/cal-1\/events\?/,
      )],
      [
        "GET",
        "/open-apis/calendar/v4/calendars/cal-1/events/event-1?user_id_type=open_id",
      ],
      [
        "PATCH",
        "/open-apis/calendar/v4/calendars/cal-1/events/event-1?user_id_type=open_id",
      ],
      [
        "POST",
        "/open-apis/calendar/v4/calendars/cal-1/events/event-1/attendees?user_id_type=open_id",
      ],
      [
        "DELETE",
        "/open-apis/calendar/v4/calendars/cal-1/events/event-1/attendees?user_id_type=open_id",
      ],
      [
        "DELETE",
        "/open-apis/calendar/v4/calendars/cal-1/events/event-1?need_notification=true",
      ],
    ]);
  });

  it("maps ambiguous writes without changing stable read/rate-limit errors", async () => {
    const Constructor = constructor();
    if (Constructor === undefined) return;
    const errors = [
      new FeishuProviderBackendError("deadline_exceeded", false),
      new FeishuProviderBackendError("feishu_permission_denied", false),
      new FeishuProviderBackendError("feishu_rate_limited", true, "3"),
    ];
    const request = vi.fn(async () => {
      throw errors.shift()!;
    });
    const backend = new Constructor({
      requests: { request },
      now: () => "2026-07-29T12:00:00.000Z",
    });

    await expect(backend.createEvent({
      calendar_id: "cal-1",
      title: "项目评审",
      start_at: "2026-07-30T09:00:00+08:00",
      end_at: "2026-07-30T10:00:00+08:00",
      time_zone: "Asia/Shanghai",
      idempotency_key: "create-1",
    })).rejects.toMatchObject({
      code: "external_outcome_unknown",
      retryable: false,
    });
    await expect(backend.readEvent({
      calendar_id: "cal-1",
      event_id: "event-1",
    })).rejects.toMatchObject({
      code: "feishu_permission_denied",
      retryable: false,
    });
    await expect(backend.deleteEvent({
      calendar_id: "cal-1",
      event_id: "event-1",
      need_notification: true,
    })).rejects.toMatchObject({
      code: "feishu_rate_limited",
      retryable: true,
      retry_after: "3",
    });
  });

  it("lets a Calendar composition classify path-specific vendor failures without changing the default client", async () => {
    const classifier = vi.fn((input: {
      readonly status: number;
      readonly code: number | string | null;
      readonly path: string;
    }) =>
      input.status === 404 && input.path.includes("/events/")
        ? new FeishuProviderBackendError("calendar_event_not_found", false)
        : null
    );
    const options = {
      credential_ref: "feishu:primary",
      token_provider: {
        getToken: vi.fn(async () => "tenant-token"),
      },
      fetch: vi.fn(async () =>
        new Response(JSON.stringify({ code: 190004, msg: "not found" }), {
          status: 404,
        })
      ),
      base_url: "https://open.feishu.test",
      request_timeout_ms: 1_000,
      max_response_bytes: 1_024,
      error_classifier: classifier,
    };
    const client = new FeishuOpenApiRequestClient(options);

    await expect(client.request(
      "GET",
      "/open-apis/calendar/v4/calendars/cal/events/event",
    )).rejects.toMatchObject({
      code: "calendar_event_not_found",
      retryable: false,
    });
    expect(classifier).toHaveBeenCalledWith({
      status: 404,
      code: 190004,
      path: "/open-apis/calendar/v4/calendars/cal/events/event",
    });
  });
});
