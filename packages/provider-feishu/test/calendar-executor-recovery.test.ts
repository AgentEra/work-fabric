import { describe, expect, it, vi } from "vitest";

import type {
  FeishuCalendarAttendeeTarget,
  FeishuCalendarBackend,
  FeishuCalendarStore,
  FeishuCapabilityExecutionRequest,
} from "../src/index.js";
import {
  FeishuCalendarCapabilityExecutor,
  FeishuProviderBackendError,
  MemoryFeishuCalendarStore,
} from "../src/index.js";

const now = "2026-07-29T12:00:00.000Z";
const eventUri = "feishu://calendar/cal-1/events/event-1";

class FailingCheckpointStore implements FeishuCalendarStore {
  fail = true;

  constructor(readonly inner: MemoryFeishuCalendarStore) {}

  bind: FeishuCalendarStore["bind"] = (...args) =>
    this.inner.bind(...args);
  getBinding: FeishuCalendarStore["getBinding"] = (...args) =>
    this.inner.getBinding(...args);
  getBindingByResource: FeishuCalendarStore["getBindingByResource"] =
    (...args) => this.inner.getBindingByResource(...args);
  getDefault: FeishuCalendarStore["getDefault"] = (...args) =>
    this.inner.getDefault(...args);
  listBindings: FeishuCalendarStore["listBindings"] = (...args) =>
    this.inner.listBindings(...args);
  setDefault: FeishuCalendarStore["setDefault"] = (...args) =>
    this.inner.setDefault(...args);
  beginExecution: FeishuCalendarStore["beginExecution"] = (...args) =>
    this.inner.beginExecution(...args);
  getExecution: FeishuCalendarStore["getExecution"] = (...args) =>
    this.inner.getExecution(...args);
  putEventOwnership: FeishuCalendarStore["putEventOwnership"] = (...args) =>
    this.inner.putEventOwnership(...args);
  getEventOwnership: FeishuCalendarStore["getEventOwnership"] = (...args) =>
    this.inner.getEventOwnership(...args);
  getEventOwnershipByCreateKey:
    FeishuCalendarStore["getEventOwnershipByCreateKey"] = (...args) =>
      this.inner.getEventOwnershipByCreateKey(...args);
  updateEventVersion: FeishuCalendarStore["updateEventVersion"] = (...args) =>
    this.inner.updateEventVersion(...args);
  markEventDeleted: FeishuCalendarStore["markEventDeleted"] = (...args) =>
    this.inner.markEventDeleted(...args);
  close: FeishuCalendarStore["close"] = (...args) =>
    this.inner.close(...args);

  async checkpoint(
    input: Parameters<FeishuCalendarStore["checkpoint"]>[0],
  ) {
    const result = await this.inner.checkpoint(input);
    if (this.fail && input.state === "event_created") {
      this.fail = false;
      throw new Error("simulated_process_crash");
    }
    return result;
  }
}

function request(): FeishuCapabilityExecutionRequest {
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
      start_at: "2026-07-30T09:00:00+08:00",
      end_at: "2026-07-30T10:00:00+08:00",
      time_zone: "Asia/Shanghai",
      attendees: ["feishu://user/open-id/ou_1"],
      notify_attendees: true,
    },
    authority: {
      allowed_resource_refs: [],
      allowed_target_refs: ["feishu://user/open-id/ou_1"],
      confirmation_proof_refs: [],
    },
  };
}

async function state(): Promise<MemoryFeishuCalendarStore> {
  const store = new MemoryFeishuCalendarStore();
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
    created_at: now,
    updated_at: now,
  }, 0);
  return store;
}

function backend(): FeishuCalendarBackend {
  return {
    getCalendar: vi.fn(),
    createSharedCalendar: vi.fn(),
    queryFreeBusy: vi.fn(),
    listPrimaryEvents: vi.fn(),
    createEvent: vi.fn(async (input) => ({
      calendar_id: input.calendar_id,
      event_id: "event-1",
      title: input.title,
      start_at: input.start_at,
      end_at: input.end_at,
      time_zone: input.time_zone,
      attendees: [],
      url: "https://feishu.example/event-1",
      updated_at: now,
    })),
    readEvent: vi.fn(async () => ({
      calendar_id: "cal-1",
      event_id: "event-1",
      title: "项目评审",
      start_at: "2026-07-30T09:00:00+08:00",
      end_at: "2026-07-30T10:00:00+08:00",
      time_zone: "Asia/Shanghai",
      attendees: [],
      url: "https://feishu.example/event-1",
      updated_at: now,
    })),
    updateEvent: vi.fn(),
    addAttendees: vi.fn(async (input) => ({
      attendees: input.attendees.map((target: FeishuCalendarAttendeeTarget) => ({
        kind: target.kind,
        external_id: target.kind === "user"
          ? target.open_id
          : target.chat_id,
        outcome: "added" as const,
      })),
    })),
    removeAttendees: vi.fn(),
    deleteEvent: vi.fn(),
  };
}

function executor(api: FeishuCalendarBackend, store: FeishuCalendarStore) {
  return new FeishuCalendarCapabilityExecutor({
    citizen_id: "citizen-feishu-calendar",
    endpoint_id: "endpoint-feishu-provider",
    backend: api,
    store,
    confirmation: { consume: vi.fn(async () => false) },
    clock: () => now,
  });
}

describe("Feishu Calendar create recovery", () => {
  it("resumes after event_created without creating a duplicate event", async () => {
    const inner = await state();
    const store = new FailingCheckpointStore(inner);
    const api = backend();
    try {
      await expect(executor(api, store).execute(request())).resolves.toMatchObject({
        outcome: "failed",
        code: "feishu_temporarily_unavailable",
      });
      await expect(store.getExecution(
        "tenant-1",
        "calendar-create-1",
      )).resolves.toMatchObject({
        state: "event_created",
        event_resource_uri: eventUri,
      });

      await expect(executor(api, store).execute(request())).resolves.toMatchObject({
        outcome: "succeeded",
        data: { completion_state: "complete" },
      });
      expect(api.createEvent).toHaveBeenCalledTimes(1);
      expect(api.addAttendees).toHaveBeenCalledTimes(1);
    } finally {
      await store.close();
    }
  });

  it("persists an ambiguous attendee outcome and refuses automatic replay", async () => {
    const store = await state();
    const api = backend();
    vi.mocked(api.addAttendees).mockRejectedValue(
      new FeishuProviderBackendError("external_outcome_unknown", false),
    );
    try {
      const calendar = executor(api, store);
      const first = await calendar.execute(request());
      const replay = await calendar.execute(request());

      expect(first).toEqual(replay);
      expect(first).toMatchObject({
        outcome: "failed",
        code: "external_outcome_unknown",
      });
      expect(api.createEvent).toHaveBeenCalledTimes(1);
      expect(api.addAttendees).toHaveBeenCalledTimes(1);
      await expect(store.getEventOwnership(
        "tenant-1",
        eventUri,
      )).resolves.toMatchObject({
        event_resource_uri: eventUri,
      });
    } finally {
      await store.close();
    }
  });
});
