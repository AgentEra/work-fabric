import { describe, expect, it, vi } from "vitest";

import type { FeishuCalendarBackend } from "../src/index.js";
import {
  FeishuCalendarAdministrationService,
  FeishuProviderBackendError,
  MemoryFeishuCalendarStore,
} from "../src/index.js";

const now = "2026-07-29T12:00:00.000Z";

function backend(): FeishuCalendarBackend {
  return {
    getCalendar: vi.fn(async (input) => ({
      calendar_id: input.calendar_id,
      summary: "团队日历",
      calendar_type: "shared" as const,
      access_role: "owner" as const,
    })),
    createSharedCalendar: vi.fn(async (input) => ({
      calendar_id: "cal-created",
      summary: input.summary,
      ...(input.description === undefined
        ? {}
        : { description: input.description }),
      calendar_type: "shared" as const,
      access_role: "owner" as const,
    })),
    queryFreeBusy: vi.fn(),
    listPrimaryEvents: vi.fn(),
    createEvent: vi.fn(),
    readEvent: vi.fn(),
    updateEvent: vi.fn(),
    addAttendees: vi.fn(),
    removeAttendees: vi.fn(),
    deleteEvent: vi.fn(),
  };
}

describe("FeishuCalendarAdministrationService", () => {
  it("validates and idempotently binds an existing writable calendar", async () => {
    const store = new MemoryFeishuCalendarStore();
    const api = backend();
    const admin = new FeishuCalendarAdministrationService({
      backend: api,
      store,
      clock: () => now,
    });
    try {
      const input = {
        tenant_id: "tenant-1",
        alias: "team",
        external_calendar_id: "cal-existing",
        make_default: true,
        operator_principal_id: "principal-admin-1",
      };
      const first = await admin.bindExisting(input);
      const replay = await admin.bindExisting(input);

      expect(first).toEqual(replay);
      expect(first).toMatchObject({
        alias: "team",
        resource_uri: "feishu://calendar/cal-existing",
        access_role: "owner",
        is_default: true,
        bound_by_principal_id: "principal-admin-1",
      });
      expect(api.getCalendar).toHaveBeenCalledTimes(1);
    } finally {
      await store.close();
    }
  });

  it("rejects unsupported calendar facts before registry mutation", async () => {
    const store = new MemoryFeishuCalendarStore();
    const api = backend();
    vi.mocked(api.getCalendar).mockResolvedValueOnce({
      calendar_id: "cal-existing",
      summary: "只读日历",
      calendar_type: "shared",
      access_role: "reader",
    } as never);
    try {
      const admin = new FeishuCalendarAdministrationService({
        backend: api,
        store,
        clock: () => now,
      });
      await expect(admin.bindExisting({
        tenant_id: "tenant-1",
        alias: "team",
        external_calendar_id: "cal-existing",
        make_default: false,
        operator_principal_id: "principal-admin-1",
      })).rejects.toMatchObject({ code: "calendar_not_writable" });
      await expect(store.getBinding("tenant-1", "team")).resolves.toBeNull();
    } finally {
      await store.close();
    }
  });

  it("creates one shared calendar and sets the default through registry CAS", async () => {
    const store = new MemoryFeishuCalendarStore();
    const api = backend();
    const admin = new FeishuCalendarAdministrationService({
      backend: api,
      store,
      clock: () => now,
    });
    try {
      const input = {
        tenant_id: "tenant-1",
        alias: "team",
        summary: "团队协作日历",
        description: "Work Fabric",
        permissions: "show_only_free_busy" as const,
        make_default: true,
        operator_principal_id: "principal-admin-1",
      };
      const first = await admin.createAndBind(input);
      const replay = await admin.createAndBind(input);

      expect(first).toEqual(replay);
      expect(first).toMatchObject({
        external_calendar_id: "cal-created",
        is_default: true,
      });
      expect(api.createSharedCalendar).toHaveBeenCalledTimes(1);
      expect(api.createSharedCalendar).toHaveBeenCalledWith({
        summary: "团队协作日历",
        description: "Work Fabric",
        permissions: "show_only_free_busy",
      });
    } finally {
      await store.close();
    }
  });

  it("blocks blind retry after an ambiguous shared-calendar creation", async () => {
    const store = new MemoryFeishuCalendarStore();
    const api = backend();
    vi.mocked(api.createSharedCalendar).mockRejectedValue(
      new FeishuProviderBackendError("external_outcome_unknown", false),
    );
    const admin = new FeishuCalendarAdministrationService({
      backend: api,
      store,
      clock: () => now,
    });
    const input = {
      tenant_id: "tenant-1",
      alias: "team",
      summary: "团队协作日历",
      permissions: "private" as const,
      make_default: false,
      operator_principal_id: "principal-admin-1",
    };
    try {
      await expect(admin.createAndBind(input)).rejects.toMatchObject({
        code: "external_outcome_unknown",
      });
      await expect(admin.createAndBind(input)).rejects.toMatchObject({
        code: "external_outcome_unknown",
      });
      expect(api.createSharedCalendar).toHaveBeenCalledTimes(1);
    } finally {
      await store.close();
    }
  });
});
