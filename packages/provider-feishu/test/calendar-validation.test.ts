import { describe, expect, it } from "vitest";

import * as provider from "../src/index.js";

type Parse = (
  capabilityId: string,
  input: Record<string, unknown>,
) => Record<string, unknown>;

function parse(): Parse | undefined {
  const value = (provider as Record<string, unknown>)[
    "parseCalendarExecutionInput"
  ];
  return typeof value === "function" ? value as Parse : undefined;
}

describe("Feishu Calendar input validation", () => {
  it("normalizes a bounded primary-calendar event-list query", () => {
    const decode = parse();
    expect(decode).toBeTypeOf("function");
    if (decode === undefined) return;

    expect(decode("feishu.calendar.events.list", {
      subject_resource_uri: "feishu://user/open-id/ou_1",
      start_at: "2026-07-31T00:00:00+08:00",
      end_at: "2026-08-03T00:00:00+08:00",
      page_size: 25,
      page_token: "opaque-page-token",
    })).toEqual({
      capability_id: "feishu.calendar.events.list",
      subject_resource_uri: "feishu://user/open-id/ou_1",
      start_at: "2026-07-31T00:00:00+08:00",
      end_at: "2026-08-03T00:00:00+08:00",
      page_size: 25,
      page_token: "opaque-page-token",
    });
  });

  it.each([
    {
      subject_resource_uri: "feishu://chat/oc_1",
      start_at: "2026-07-31T00:00:00+08:00",
      end_at: "2026-08-03T00:00:00+08:00",
      page_size: 25,
    },
    {
      subject_resource_uri: "feishu://user/open-id/ou_1",
      start_at: "2026-07-01T00:00:00Z",
      end_at: "2026-08-02T00:00:00Z",
      page_size: 25,
    },
    {
      subject_resource_uri: "feishu://user/open-id/ou_1",
      start_at: "2026-07-31T00:00:00Z",
      end_at: "2026-08-01T00:00:00Z",
      page_size: 51,
    },
    {
      subject_resource_uri: "feishu://user/open-id/ou_1",
      start_at: "2026-07-31T00:00:00Z",
      end_at: "2026-08-01T00:00:00Z",
      page_size: 25,
      unexpected: true,
    },
  ])("rejects invalid event-list input %#", (input) => {
    const decode = parse();
    if (decode === undefined) return;
    expect(() => decode("feishu.calendar.events.list", input))
      .toThrow(/input|range|subject|page|user/i);
  });

  it("normalizes a bounded free/busy query with Authority evidence", () => {
    const decode = parse();
    expect(decode).toBeTypeOf("function");
    if (decode === undefined) return;

    expect(decode("feishu.calendar.freebusy.query", {
      start_at: "2026-07-30T09:00:00+08:00",
      end_at: "2026-07-30T18:00:00+08:00",
      participants: [
        "feishu://user/open-id/ou_1",
        "feishu://user/open-id/ou_2",
      ],
      include_external_calendars: false,
      busy_only: true,
      authority_evidence: {
        capability_result_handoff_ids: ["handoff-members-1"],
      },
    })).toEqual({
      capability_id: "feishu.calendar.freebusy.query",
      start_at: "2026-07-30T09:00:00+08:00",
      end_at: "2026-07-30T18:00:00+08:00",
      participants: [
        "feishu://user/open-id/ou_1",
        "feishu://user/open-id/ou_2",
      ],
      include_external_calendars: false,
      busy_only: true,
      authority_evidence: {
        capability_result_handoff_ids: ["handoff-members-1"],
      },
    });
  });

  it("normalizes event creation without accepting raw external IDs", () => {
    const decode = parse();
    if (decode === undefined) return;

    expect(decode("feishu.calendar.event.create", {
      calendar: { kind: "default_calendar" },
      title: "项目评审",
      start_at: "2026-07-30T09:00:00+08:00",
      end_at: "2026-07-30T10:00:00+08:00",
      time_zone: "Asia/Shanghai",
      attendees: ["feishu://chat/oc_1"],
      description: "评审第一阶段交付",
      authority_evidence: {
        session_origin_handoff_id: "handoff-origin-1",
        confirmation_handoff_id: "handoff-confirmation-1",
        proposal_digest: `sha256:${"b".repeat(64)}`,
        capability_result_handoff_ids: ["handoff-members-1"],
      },
    })).toMatchObject({
      capability_id: "feishu.calendar.event.create",
      calendar: { kind: "default_calendar" },
      title: "项目评审",
      time_zone: "Asia/Shanghai",
      attendees: ["feishu://chat/oc_1"],
      authority_evidence: {
        session_origin_handoff_id: "handoff-origin-1",
        confirmation_handoff_id: "handoff-confirmation-1",
        proposal_digest: `sha256:${"b".repeat(64)}`,
        capability_result_handoff_ids: ["handoff-members-1"],
      },
    });
    expect(() => decode("feishu.calendar.event.create", {
      calendar_id: "raw-calendar-id",
      title: "项目评审",
      start_at: "2026-07-30T09:00:00+08:00",
      end_at: "2026-07-30T10:00:00+08:00",
      time_zone: "Asia/Shanghai",
      attendees: [],
    })).toThrow(/input/i);
  });

  it.each([
    {
      start_at: "2026-07-30T10:00:00+08:00",
      end_at: "2026-07-30T09:00:00+08:00",
      participants: ["feishu://user/open-id/ou_1"],
      include_external_calendars: false,
      busy_only: true,
    },
    {
      start_at: "2026-07-01T00:00:00Z",
      end_at: "2026-07-16T00:00:00Z",
      participants: ["feishu://user/open-id/ou_1"],
      include_external_calendars: false,
      busy_only: true,
    },
    {
      start_at: "2026-07-30T09:00:00Z",
      end_at: "2026-07-30T10:00:00Z",
      participants: [
        "feishu://user/open-id/ou_1",
        "feishu://user/open-id/ou_1",
      ],
      include_external_calendars: false,
      busy_only: true,
    },
  ])("rejects invalid free/busy bounds %#", (input) => {
    const decode = parse();
    if (decode === undefined) return;
    expect(() =>
      decode("feishu.calendar.freebusy.query", input)
    ).toThrow(/input|range/i);
  });

  it("rejects unknown time zones and empty update field masks", () => {
    const decode = parse();
    if (decode === undefined) return;
    expect(() => decode("feishu.calendar.event.create", {
      calendar: { kind: "default_calendar" },
      title: "项目评审",
      start_at: "2026-07-30T09:00:00+08:00",
      end_at: "2026-07-30T10:00:00+08:00",
      time_zone: "Mars/Olympus",
      attendees: [],
    })).toThrow(/time zone|input/i);
    expect(() => decode("feishu.calendar.event.update", {
      event: {
        resource_uri: "feishu://calendar/cal/events/event",
      },
      expected_provider_version: 1,
      field_mask: [],
      changes: {},
    })).toThrow(/field mask|input/i);
  });

  it("normalizes read, attendee mutation and confirmed delete inputs", () => {
    const decode = parse();
    if (decode === undefined) return;
    const event = {
      resource_uri: "feishu://calendar/cal/events/event",
    };

    expect(decode("feishu.calendar.event.read", { event })).toEqual({
      capability_id: "feishu.calendar.event.read",
      event,
    });
    expect(decode("feishu.calendar.attendees.add", {
      event,
      expected_provider_version: 2,
      attendees: [
        "feishu://user/open-id/ou_1",
        "feishu://chat/oc_1",
      ],
      notify_attendees: true,
    })).toMatchObject({
      capability_id: "feishu.calendar.attendees.add",
      expected_provider_version: 2,
      attendees: [
        "feishu://user/open-id/ou_1",
        "feishu://chat/oc_1",
      ],
    });
    expect(decode("feishu.calendar.event.delete", {
      event,
      expected_provider_version: 2,
      confirmation_proof: "confirmation-proof-1",
    })).toMatchObject({
      capability_id: "feishu.calendar.event.delete",
      expected_provider_version: 2,
      confirmation_proof: "confirmation-proof-1",
    });
  });

  it.each([
    {
      field_mask: ["title"],
      changes: { title: " 未修剪标题" },
    },
    {
      field_mask: ["time_zone"],
      changes: { time_zone: "Mars/Olympus" },
    },
    {
      field_mask: ["reminders"],
      changes: { reminders: [10, 10] },
    },
    {
      field_mask: ["notify_attendees"],
      changes: { notify_attendees: "yes" },
    },
  ])("validates every selected update field %#", ({ field_mask, changes }) => {
    const decode = parse();
    if (decode === undefined) return;
    expect(() => decode("feishu.calendar.event.update", {
      event: {
        resource_uri: "feishu://calendar/cal/events/event",
      },
      expected_provider_version: 2,
      field_mask,
      changes,
    })).toThrow(/input|time zone|reminder/i);
  });
});
