import { describe, expect, it, vi } from "vitest";

import type {
  FeishuCalendarAttendeeTarget,
  FeishuCalendarBackend,
  FeishuCalendarConfirmationVerifier,
  FeishuCalendarStore,
  FeishuCapabilityExecutionRequest,
} from "../src/index.js";
import {
  FeishuCalendarCapabilityExecutor,
  FeishuProviderBackendError,
  MemoryFeishuCalendarStore,
} from "../src/index.js";

const now = "2026-07-29T12:00:00.000Z";
const calendarUri = "feishu://calendar/cal-1";
const eventUri = "feishu://calendar/cal-1/events/event-1";

function backend(): FeishuCalendarBackend {
  return {
    getCalendar: vi.fn(),
    createSharedCalendar: vi.fn(),
    queryFreeBusy: vi.fn(),
    createEvent: vi.fn(async (input) => ({
      calendar_id: input.calendar_id,
      event_id: "event-1",
      title: input.title,
      ...(input.description === undefined
        ? {}
        : { description: input.description }),
      start_at: input.start_at,
      end_at: input.end_at,
      time_zone: input.time_zone,
      visibility: input.visibility,
      attendee_ability: input.attendee_ability,
      attendees: [],
      url: "https://feishu.example/calendar/event-1",
      created_at: now,
      updated_at: now,
    })),
    readEvent: vi.fn(async (input) => ({
      calendar_id: input.calendar_id,
      event_id: input.event_id,
      title: "项目评审",
      start_at: "2026-07-30T09:00:00+08:00",
      end_at: "2026-07-30T10:00:00+08:00",
      time_zone: "Asia/Shanghai",
      attendees: [],
      updated_at: now,
    })),
    updateEvent: vi.fn(async (input) => ({
      calendar_id: input.calendar_id,
      event_id: input.event_id,
      title: String(input.changes.title ?? "项目评审"),
      start_at: "2026-07-30T09:00:00+08:00",
      end_at: "2026-07-30T10:00:00+08:00",
      time_zone: "Asia/Shanghai",
      attendees: [],
      updated_at: "2026-07-29T12:05:00.000Z",
    })),
    addAttendees: vi.fn(async (input) => ({
      attendees: input.attendees.map((target: FeishuCalendarAttendeeTarget) => ({
        kind: target.kind,
        external_id: target.kind === "user"
          ? target.open_id
          : target.chat_id,
        outcome: "added" as const,
      })),
    })),
    removeAttendees: vi.fn(async (input) => ({
      attendees: input.attendees.map((target: FeishuCalendarAttendeeTarget) => ({
        kind: target.kind,
        external_id: target.kind === "user"
          ? target.open_id
          : target.chat_id,
        outcome: "removed" as const,
      })),
    })),
    deleteEvent: vi.fn(async (input) => ({
      calendar_id: input.calendar_id,
      event_id: input.event_id,
      deleted_at: "2026-07-29T12:10:00.000Z",
    })),
  };
}

async function store(): Promise<MemoryFeishuCalendarStore> {
  const state = new MemoryFeishuCalendarStore();
  await state.bind({
    tenant_id: "tenant-1",
    alias: "team",
    resource_uri: calendarUri,
    external_calendar_id: "cal-1",
    calendar_type: "shared",
    access_role: "owner",
    is_default: true,
    active: true,
    bound_by_principal_id: "principal-operator-1",
    created_at: now,
    updated_at: now,
  }, 0);
  return state;
}

function createRequest(
  overrides: Partial<FeishuCapabilityExecutionRequest> = {},
): FeishuCapabilityExecutionRequest {
  return {
    tenant_id: "tenant-1",
    original_handoff_id: "handoff-1",
    represented_actor_id: "actor-human-1",
    delegation_id: "delegation-calendar-1",
    delegation_scopes: ["calendar_event:write"],
    delegation_expires_at: "2026-07-29T13:00:00.000Z",
    invocation_id: "invocation-create-1",
    idempotency_key: "calendar-create-1",
    capability_id: "feishu.calendar.event.create",
    input: {
      calendar: { kind: "default_calendar" },
      title: "项目评审",
      description: "第一阶段",
      start_at: "2026-07-30T09:00:00+08:00",
      end_at: "2026-07-30T10:00:00+08:00",
      time_zone: "Asia/Shanghai",
      attendees: [
        "feishu://user/open-id/ou_1",
        "feishu://chat/oc_1",
      ],
      visibility: "public",
      attendee_ability: "can_invite_others",
      reminders: [10],
      notify_attendees: true,
    },
    authority: {
      allowed_resource_refs: [],
      allowed_target_refs: [
        "feishu://user/open-id/ou_1",
        "feishu://chat/oc_1",
      ],
      confirmation_proof_refs: [],
    },
    ...overrides,
  };
}

function executor(input: {
  readonly backend: FeishuCalendarBackend;
  readonly store: FeishuCalendarStore;
  readonly confirmation?: FeishuCalendarConfirmationVerifier;
}) {
  return new FeishuCalendarCapabilityExecutor({
    citizen_id: "citizen-feishu-calendar",
    endpoint_id: "endpoint-feishu-provider",
    backend: input.backend,
    store: input.store,
    confirmation: input.confirmation ?? {
      consume: vi.fn(async () => false),
    },
    clock: () => now,
  });
}

describe("FeishuCalendarCapabilityExecutor commands", () => {
  it("creates an event once, checkpoints attendees and replays the typed result", async () => {
    const state = await store();
    const api = backend();
    try {
      const calendar = executor({ backend: api, store: state });
      const first = await calendar.execute(createRequest());
      const replay = await calendar.execute(createRequest());

      expect(first).toEqual(replay);
      expect(first).toMatchObject({
        outcome: "succeeded",
        data: {
          event_resource_uri: eventUri,
          calendar_resource_uri: calendarUri,
          organizer_mode: "application",
          provider_version: 1,
          completion_state: "complete",
          attendee_outcomes: [
            {
              resource_uri: "feishu://user/open-id/ou_1",
              outcome: "added",
            },
            {
              resource_uri: "feishu://chat/oc_1",
              outcome: "added",
            },
          ],
        },
      });
      expect(api.createEvent).toHaveBeenCalledTimes(1);
      expect(api.addAttendees).toHaveBeenCalledTimes(1);
      await expect(state.getEventOwnership(
        "tenant-1",
        eventUri,
      )).resolves.toMatchObject({
        initiating_actor_id: "actor-human-1",
        create_idempotency_key: "calendar-create-1",
        provider_version: 1,
      });
      await expect(state.getExecution(
        "tenant-1",
        "calendar-create-1",
      )).resolves.toMatchObject({
        state: "completed",
        outcome: first,
      });
    } finally {
      await state.close();
    }
  });

  it("rejects unauthorized attendees and non-writable registered calendars before external writes", async () => {
    const state = await store();
    const api = backend();
    try {
      const calendar = executor({ backend: api, store: state });
      await expect(calendar.execute(createRequest({
        authority: {
          allowed_resource_refs: [],
          allowed_target_refs: ["feishu://user/open-id/ou_1"],
          confirmation_proof_refs: [],
        },
      }))).resolves.toMatchObject({
        outcome: "rejected",
        code: "target_not_allowed",
      });
      const current = (await state.getDefault("tenant-1"))!;
      await state.bind({
        ...current,
        access_role: "writer",
        active: false,
        updated_at: "2026-07-29T12:01:00.000Z",
      }, current.version);
      await expect(calendar.execute(createRequest({
        idempotency_key: "calendar-create-2",
        invocation_id: "invocation-create-2",
      }))).resolves.toMatchObject({
        outcome: "rejected",
        code: "calendar_not_registered",
      });
      expect(api.createEvent).not.toHaveBeenCalled();
    } finally {
      await state.close();
    }
  });

  it("updates only Provider-owned events at the expected local and external versions", async () => {
    const state = await store();
    const api = backend();
    try {
      const calendar = executor({ backend: api, store: state });
      await calendar.execute(createRequest({
        input: {
          calendar: { kind: "default_calendar" },
          title: "项目评审",
          start_at: "2026-07-30T09:00:00+08:00",
          end_at: "2026-07-30T10:00:00+08:00",
          time_zone: "Asia/Shanghai",
          attendees: [],
        },
      }));
      const update = createRequest({
        invocation_id: "invocation-update-1",
        idempotency_key: "calendar-update-1",
        capability_id: "feishu.calendar.event.update",
        authority: {
          allowed_resource_refs: [eventUri],
          allowed_target_refs: [],
          confirmation_proof_refs: [],
        },
        input: {
          event: { resource_uri: eventUri },
          expected_provider_version: 1,
          field_mask: ["title"],
          changes: { title: "项目终审" },
        },
      });
      await expect(calendar.execute(update)).resolves.toMatchObject({
        outcome: "succeeded",
        data: {
          event_resource_uri: eventUri,
          title: "项目终审",
          provider_version: 2,
        },
      });
      await expect(calendar.execute({
        ...update,
        invocation_id: "invocation-update-stale",
        idempotency_key: "calendar-update-stale",
      })).resolves.toMatchObject({
        outcome: "rejected",
        code: "event_version_conflict",
      });
      expect(api.updateEvent).toHaveBeenCalledTimes(1);

      const ownership = (await state.getEventOwnership(
        "tenant-1",
        eventUri,
      ))!;
      await state.putEventOwnership({
        ...ownership,
      });
      vi.mocked(api.readEvent).mockResolvedValueOnce({
        calendar_id: "cal-1",
        event_id: "event-1",
        title: "外部修改",
        start_at: "2026-07-30T09:00:00+08:00",
        end_at: "2026-07-30T10:00:00+08:00",
        time_zone: "Asia/Shanghai",
        attendees: [],
        updated_at: "2026-07-29T12:09:00.000Z",
      });
      await expect(calendar.execute({
        ...update,
        invocation_id: "invocation-update-external",
        idempotency_key: "calendar-update-external",
        input: {
          ...update.input,
          expected_provider_version: 2,
        },
      })).resolves.toMatchObject({
        outcome: "rejected",
        code: "external_concurrent_change",
      });
    } finally {
      await state.close();
    }
  });

  it("distinguishes unowned events and preserves the event URI for partial attendee writes", async () => {
    const state = await store();
    const api = backend();
    try {
      const calendar = executor({ backend: api, store: state });
      await expect(calendar.execute(createRequest({
        invocation_id: "invocation-unowned",
        idempotency_key: "calendar-unowned",
        capability_id: "feishu.calendar.event.update",
        authority: {
          allowed_resource_refs: [eventUri],
          allowed_target_refs: [],
          confirmation_proof_refs: [],
        },
        input: {
          event: { resource_uri: eventUri },
          expected_provider_version: 1,
          field_mask: ["title"],
          changes: { title: "不应写入" },
        },
      }))).resolves.toMatchObject({
        outcome: "rejected",
        code: "event_not_owned",
      });

      vi.mocked(api.addAttendees).mockResolvedValueOnce({
        attendees: [{
          kind: "user",
          external_id: "ou_1",
          outcome: "added",
        }],
      });
      await expect(calendar.execute(createRequest({
        invocation_id: "invocation-partial",
        idempotency_key: "calendar-partial",
      }))).resolves.toMatchObject({
        outcome: "succeeded",
        data: {
          event_resource_uri: eventUri,
          completion_state: "partial",
          attendee_outcomes: [
            {
              resource_uri: "feishu://user/open-id/ou_1",
              outcome: "added",
            },
            {
              resource_uri: "feishu://chat/oc_1",
              outcome: "rejected",
              code: "attendee_result_missing",
            },
          ],
        },
      });
      expect(api.updateEvent).not.toHaveBeenCalled();
    } finally {
      await state.close();
    }
  });

  it("surfaces retryable Feishu throttling without completing the execution", async () => {
    const state = await store();
    const api = backend();
    vi.mocked(api.createEvent).mockRejectedValueOnce(
      new FeishuProviderBackendError("feishu_rate_limited", true, "3"),
    );
    try {
      const calendar = executor({ backend: api, store: state });
      await expect(calendar.execute(createRequest())).resolves.toMatchObject({
        outcome: "failed",
        code: "feishu_rate_limited",
        retryable: true,
        retry_after: "3",
      });
      await expect(state.getExecution(
        "tenant-1",
        "calendar-create-1",
      )).resolves.toMatchObject({
        state: "started",
        outcome: null,
      });
    } finally {
      await state.close();
    }
  });

  it("consumes one Authority-bound confirmation and tombstones delete before replay", async () => {
    const state = await store();
    const api = backend();
    const consume = vi.fn(async () => true);
    try {
      const calendar = executor({
        backend: api,
        store: state,
        confirmation: { consume },
      });
      await calendar.execute(createRequest({
        input: {
          calendar: { kind: "default_calendar" },
          title: "项目评审",
          start_at: "2026-07-30T09:00:00+08:00",
          end_at: "2026-07-30T10:00:00+08:00",
          time_zone: "Asia/Shanghai",
          attendees: [],
        },
      }));
      const deletion = createRequest({
        invocation_id: "invocation-delete-1",
        idempotency_key: "calendar-delete-1",
        capability_id: "feishu.calendar.event.delete",
        delegation_scopes: ["calendar_event:delete"],
        authority: {
          allowed_resource_refs: [eventUri],
          allowed_target_refs: [],
          confirmation_proof_refs: ["confirmation-1"],
        },
        input: {
          event: { resource_uri: eventUri },
          expected_provider_version: 1,
          confirmation_proof: "confirmation-1",
        },
      });
      const first = await calendar.execute(deletion);
      const replay = await calendar.execute(deletion);

      expect(first).toEqual(replay);
      expect(first).toMatchObject({
        outcome: "succeeded",
        data: {
          event_resource_uri: eventUri,
          provider_version: 2,
          deleted_at: "2026-07-29T12:10:00.000Z",
        },
      });
      expect(consume).toHaveBeenCalledTimes(1);
      expect(api.deleteEvent).toHaveBeenCalledTimes(1);
      await expect(state.getEventOwnership(
        "tenant-1",
        eventUri,
      )).resolves.toMatchObject({
        deleted_at: "2026-07-29T12:10:00.000Z",
        provider_version: 2,
      });
    } finally {
      await state.close();
    }
  });

  it("distinguishes missing and invalid destructive confirmation", async () => {
    const state = await store();
    const api = backend();
    try {
      const calendar = executor({ backend: api, store: state });
      await calendar.execute(createRequest({
        input: {
          calendar: { kind: "default_calendar" },
          title: "项目评审",
          start_at: "2026-07-30T09:00:00+08:00",
          end_at: "2026-07-30T10:00:00+08:00",
          time_zone: "Asia/Shanghai",
          attendees: [],
        },
      }));
      const deletion = createRequest({
        invocation_id: "invocation-delete-2",
        idempotency_key: "calendar-delete-2",
        capability_id: "feishu.calendar.event.delete",
        delegation_scopes: ["calendar_event:delete"],
        authority: {
          allowed_resource_refs: [eventUri],
          allowed_target_refs: [],
          confirmation_proof_refs: [],
        },
        input: {
          event: { resource_uri: eventUri },
          expected_provider_version: 1,
          confirmation_proof: "confirmation-2",
        },
      });
      await expect(calendar.execute(deletion)).resolves.toMatchObject({
        outcome: "rejected",
        code: "confirmation_required",
      });
      await expect(calendar.execute({
        ...deletion,
        idempotency_key: "calendar-delete-3",
        authority: {
          ...deletion.authority,
          confirmation_proof_refs: ["confirmation-2"],
        },
      })).resolves.toMatchObject({
        outcome: "rejected",
        code: "confirmation_invalid",
      });
      expect(api.deleteEvent).not.toHaveBeenCalled();
    } finally {
      await state.close();
    }
  });

  it("consumes destructive confirmation once across a retryable Feishu failure", async () => {
    const state = await store();
    const api = backend();
    const consume = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    vi.mocked(api.deleteEvent)
      .mockRejectedValueOnce(
        new FeishuProviderBackendError("feishu_rate_limited", true, "3"),
      )
      .mockResolvedValueOnce({
        calendar_id: "cal-1",
        event_id: "event-1",
        deleted_at: "2026-07-29T12:10:00.000Z",
      });
    try {
      const calendar = executor({
        backend: api,
        store: state,
        confirmation: { consume },
      });
      await calendar.execute(createRequest({
        input: {
          calendar: { kind: "default_calendar" },
          title: "项目评审",
          start_at: "2026-07-30T09:00:00+08:00",
          end_at: "2026-07-30T10:00:00+08:00",
          time_zone: "Asia/Shanghai",
          attendees: [],
        },
      }));
      const deletion = createRequest({
        invocation_id: "invocation-delete-retry",
        idempotency_key: "calendar-delete-retry",
        capability_id: "feishu.calendar.event.delete",
        delegation_scopes: ["calendar_event:delete"],
        authority: {
          allowed_resource_refs: [eventUri],
          allowed_target_refs: [],
          confirmation_proof_refs: ["confirmation-retry"],
        },
        input: {
          event: { resource_uri: eventUri },
          expected_provider_version: 1,
          confirmation_proof: "confirmation-retry",
        },
      });
      await expect(calendar.execute(deletion)).resolves.toMatchObject({
        outcome: "failed",
        code: "feishu_rate_limited",
        retryable: true,
      });
      await expect(calendar.execute(deletion)).resolves.toMatchObject({
        outcome: "succeeded",
        data: { event_resource_uri: eventUri },
      });
      expect(consume).toHaveBeenCalledTimes(1);
      expect(api.deleteEvent).toHaveBeenCalledTimes(2);
    } finally {
      await state.close();
    }
  });
});
