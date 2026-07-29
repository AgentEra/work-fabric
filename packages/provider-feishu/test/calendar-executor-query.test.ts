import { describe, expect, it, vi } from "vitest";

import type {
  FeishuCalendarBackend,
  FeishuCalendarStore,
  FeishuCapabilityExecutionRequest,
  FeishuCapabilityOutcome,
} from "../src/index.js";
import {
  MemoryFeishuCalendarStore,
} from "../src/index.js";
import * as provider from "../src/index.js";

type Executor = {
  execute(request: FeishuCapabilityExecutionRequest):
    Promise<FeishuCapabilityOutcome>;
};

type Constructor = new (input: {
  readonly citizen_id: string;
  readonly endpoint_id: string;
  readonly backend: FeishuCalendarBackend;
  readonly store: FeishuCalendarStore;
  readonly confirmation: { consume(input: unknown): Promise<boolean> };
  readonly clock?: () => string;
}) => Executor;

function constructor(): Constructor | undefined {
  const value = (provider as Record<string, unknown>)[
    "FeishuCalendarCapabilityExecutor"
  ];
  return typeof value === "function" ? value as Constructor : undefined;
}

function request(input: {
  readonly capability_id?: string;
  readonly value?: Record<string, unknown>;
  readonly scopes?: readonly string[];
  readonly allowed_target_refs?: readonly string[];
  readonly allowed_resource_refs?: readonly string[];
} = {}): FeishuCapabilityExecutionRequest {
  return {
    tenant_id: "tenant-1",
    original_handoff_id: "handoff-1",
    represented_actor_id: "actor-human-1",
    delegation_id: "delegation-calendar-1",
    delegation_scopes: input.scopes ?? ["calendar:freebusy:read"],
    delegation_expires_at: "2026-07-29T13:00:00.000Z",
    invocation_id: "invocation-calendar-1",
    idempotency_key: "calendar-1",
    capability_id:
      input.capability_id ?? "feishu.calendar.freebusy.query",
    input: input.value ?? {
      start_at: "2026-07-30T09:00:00+08:00",
      end_at: "2026-07-30T18:00:00+08:00",
      participants: ["feishu://user/open-id/ou_1"],
      include_external_calendars: false,
      busy_only: true,
    },
    authority: {
      allowed_resource_refs: input.allowed_resource_refs ?? [],
      allowed_target_refs:
        input.allowed_target_refs ?? ["feishu://user/open-id/ou_1"],
      confirmation_proof_refs: [],
    },
  };
}

function backend(): FeishuCalendarBackend {
  return {
    getCalendar: vi.fn(),
    createSharedCalendar: vi.fn(),
    queryFreeBusy: vi.fn(async (input) => ({
      start_at: input.start_at,
      end_at: input.end_at,
      participants: input.user_open_ids.map((openId: string) => ({
        open_id: openId,
        busy_intervals: [{
          start_at: "2026-07-30T09:00:00+08:00",
          end_at: "2026-07-30T09:30:00+08:00",
        }],
      })),
      unresolved: [],
    })),
    createEvent: vi.fn(),
    readEvent: vi.fn(async (input) => ({
      calendar_id: input.calendar_id,
      event_id: input.event_id,
      title: "项目评审",
      start_at: "2026-07-30T09:00:00+08:00",
      end_at: "2026-07-30T10:00:00+08:00",
      time_zone: "Asia/Shanghai",
      visibility: "public",
      organizer_open_id: "ou-bot",
      attendees: [{
        kind: "user" as const,
        open_id: "ou_1",
      }],
      updated_at: "2026-07-29T12:01:00.000Z",
    })),
    updateEvent: vi.fn(),
    addAttendees: vi.fn(),
    removeAttendees: vi.fn(),
    deleteEvent: vi.fn(),
  };
}

function executor(store: FeishuCalendarStore, api = backend()): Executor {
  const Constructor = constructor();
  if (Constructor === undefined) {
    throw new TypeError("FeishuCalendarCapabilityExecutor is unavailable");
  }
  return new Constructor({
    citizen_id: "citizen-feishu-calendar",
    endpoint_id: "endpoint-feishu-provider",
    backend: api,
    store,
    confirmation: { consume: vi.fn(async () => false) },
    clock: () => "2026-07-29T12:00:00.000Z",
  });
}

describe("FeishuCalendarCapabilityExecutor query boundary", () => {
  it("is exposed as an independent Calendar capability executor", () => {
    expect(constructor()).toBeTypeOf("function");
  });

  it("requires both free/busy scope and every participant target", async () => {
    const store = new MemoryFeishuCalendarStore();
    try {
      const calendar = executor(store);
      await expect(calendar.execute(request({
        scopes: [],
      }))).resolves.toMatchObject({
        outcome: "rejected",
        code: "scope_not_granted",
      });
      await expect(calendar.execute(request({
        allowed_target_refs: [],
      }))).resolves.toMatchObject({
        outcome: "rejected",
        code: "target_not_allowed",
      });
    } finally {
      await store.close();
    }
  });

  it("returns ordered free/busy facts without selecting a meeting time", async () => {
    const store = new MemoryFeishuCalendarStore();
    const api = backend();
    try {
      await expect(executor(store, api).execute(request())).resolves.toEqual({
        outcome: "succeeded",
        data: {
          coverage: {
            start_at: "2026-07-30T09:00:00+08:00",
            end_at: "2026-07-30T18:00:00+08:00",
          },
          participants: [{
            resource_uri: "feishu://user/open-id/ou_1",
            busy_intervals: [{
              start_at: "2026-07-30T09:00:00+08:00",
              end_at: "2026-07-30T09:30:00+08:00",
            }],
          }],
          unresolved_participants: [],
          provenance: {
            provider_family: "feishu",
            source: "feishu.calendar.freebusy",
          },
        },
        artifacts: [],
      });
      expect(api.queryFreeBusy).toHaveBeenCalledWith({
        user_open_ids: ["ou_1"],
        start_at: "2026-07-30T09:00:00+08:00",
        end_at: "2026-07-30T18:00:00+08:00",
        include_external_calendars: false,
        busy_only: true,
      });
    } finally {
      await store.close();
    }
  });

  it("reads only an Authority-bound event on an active registered calendar", async () => {
    const store = new MemoryFeishuCalendarStore();
    const api = backend();
    const eventUri = "feishu://calendar/cal-1/events/event-1";
    try {
      await store.bind({
        tenant_id: "tenant-1",
        alias: "team",
        resource_uri: "feishu://calendar/cal-1",
        external_calendar_id: "cal-1",
        calendar_type: "shared",
        access_role: "owner",
        is_default: true,
        active: true,
        bound_by_principal_id: "principal-operator-1",
        created_at: "2026-07-29T12:00:00.000Z",
        updated_at: "2026-07-29T12:00:00.000Z",
      }, 0);
      const calendar = executor(store, api);
      const read = request({
        capability_id: "feishu.calendar.event.read",
        scopes: ["calendar:event:read"],
        allowed_resource_refs: [eventUri],
        value: { event: { resource_uri: eventUri } },
      });

      await expect(calendar.execute(read)).resolves.toMatchObject({
        outcome: "succeeded",
        data: {
          event_resource_uri: eventUri,
          calendar_resource_uri: "feishu://calendar/cal-1",
          event_id: "event-1",
          title: "项目评审",
          attendees: ["feishu://user/open-id/ou_1"],
          provenance: {
            provider_family: "feishu",
            source: "feishu.calendar.event",
          },
        },
      });
      await expect(calendar.execute({
        ...read,
        authority: {
          ...read.authority,
          allowed_resource_refs: [],
        },
      })).resolves.toMatchObject({
        outcome: "rejected",
        code: "resource_not_allowed",
      });
      expect(api.readEvent).toHaveBeenCalledWith({
        calendar_id: "cal-1",
        event_id: "event-1",
      });
    } finally {
      await store.close();
    }
  });
});
