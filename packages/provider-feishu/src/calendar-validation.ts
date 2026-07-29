import type {
  CalendarAttendeeAbility,
  CalendarAttendeeMutationInput,
  CalendarAuthorityEvidenceInput,
  CalendarEventCreateInput,
  CalendarEventDeleteInput,
  CalendarEventReadInput,
  CalendarEventReference,
  CalendarEventUpdateInput,
  CalendarExecutionInput,
  CalendarFreeBusyInput,
  CalendarSelector,
  CalendarVisibility,
} from "./calendar-contracts.js";
import {
  FeishuCalendarResourceAdapter,
} from "./calendar-resource-adapter.js";

const resources = new FeishuCalendarResourceAdapter();
const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_EVENT_DURATION_MS = 14 * 24 * 60 * 60 * 1_000;
const MAX_FREEBUSY_SPAN_MS = 14 * 24 * 60 * 60 * 1_000;
const UPDATE_FIELDS = new Set([
  "title",
  "description",
  "start_at",
  "end_at",
  "time_zone",
  "visibility",
  "attendee_ability",
  "reminders",
  "notify_attendees",
]);

function invalid(detail: string): never {
  throw new TypeError(`Feishu Calendar input is invalid: ${detail}`);
}

function record(value: unknown, detail: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) invalid(detail);
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  detail: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) invalid(detail);
}

function string(
  value: unknown,
  detail: string,
  maximum: number,
  minimum = 1,
): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    value.trim() !== value
  ) invalid(detail);
  return value;
}

function integer(
  value: unknown,
  detail: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) invalid(detail);
  return value as number;
}

function boolean(value: unknown, detail: string): boolean {
  if (typeof value !== "boolean") invalid(detail);
  return value;
}

function timestamp(value: unknown, detail: string): string {
  const result = string(value, detail, 128);
  if (!RFC3339.test(result) || !Number.isFinite(Date.parse(result))) {
    invalid(detail);
  }
  return result;
}

function timeZone(value: unknown): string {
  const result = string(value, "time zone", 255);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: result }).format(0);
  } catch {
    invalid("time zone");
  }
  return result;
}

function selector(value: unknown): CalendarSelector {
  const selected = record(value, "calendar selector");
  if (
    selected.kind === "default_calendar" &&
    Object.keys(selected).length === 1
  ) return Object.freeze({ kind: "default_calendar" });
  if (selected.kind === "calendar_alias") {
    exact(selected, ["kind", "alias"], [], "calendar selector");
    return Object.freeze({
      kind: "calendar_alias",
      alias: string(selected.alias, "calendar alias", 128),
    });
  }
  if (selected.kind === "resource_reference") {
    exact(
      selected,
      ["kind", "resource_uri"],
      [],
      "calendar selector",
    );
    const resourceUri = string(
      selected.resource_uri,
      "calendar resource",
      2_048,
    );
    resources.parseCalendar(resourceUri);
    return Object.freeze({
      kind: "resource_reference",
      resource_uri: resourceUri,
    });
  }
  invalid("calendar selector");
}

function eventReference(value: unknown): CalendarEventReference {
  const reference = record(value, "event reference");
  exact(reference, ["resource_uri"], [], "event reference");
  const resourceUri = string(
    reference.resource_uri,
    "event resource",
    2_048,
  );
  resources.parseEvent(resourceUri);
  return Object.freeze({ resource_uri: resourceUri });
}

function participantRefs(
  value: unknown,
  options: { readonly allow_chat: boolean; readonly minimum: number },
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length < options.minimum ||
    value.length > 100
  ) invalid("participants");
  const result = value.map((item) => {
    const resourceUri = string(item, "participant resource", 2_048);
    if (resourceUri.startsWith("feishu://user/open-id/")) {
      resources.parseUser(resourceUri);
    } else if (
      options.allow_chat &&
      resourceUri.startsWith("feishu://chat/")
    ) {
      resources.parseChat(resourceUri);
    } else {
      invalid("participant resource");
    }
    return resourceUri;
  });
  if (new Set(result).size !== result.length) {
    invalid("duplicate participants");
  }
  return Object.freeze(result);
}

function authorityEvidence(
  value: unknown,
): CalendarAuthorityEvidenceInput {
  const evidence = record(value, "authority evidence");
  exact(
    evidence,
    ["capability_result_handoff_ids"],
    [],
    "authority evidence",
  );
  const handoffs = evidence.capability_result_handoff_ids;
  if (!Array.isArray(handoffs) || handoffs.length < 1 || handoffs.length > 8) {
    invalid("authority evidence");
  }
  const normalized = handoffs.map((item) => {
    const result = string(item, "authority evidence Handoff", 255);
    if (!OPAQUE_ID.test(result)) invalid("authority evidence Handoff");
    return result;
  });
  if (new Set(normalized).size !== normalized.length) {
    invalid("duplicate authority evidence");
  }
  return Object.freeze({
    capability_result_handoff_ids: Object.freeze(normalized),
  });
}

function optionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  detail: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    invalid(detail);
  }
  return value as T;
}

function reminders(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length > 10) invalid("reminders");
  const result = value.map((item) =>
    integer(item, "reminder", 0, 40_320)
  );
  if (new Set(result).size !== result.length) {
    invalid("duplicate reminders");
  }
  return Object.freeze(result);
}

export function assertCalendarTimeRange(input: {
  readonly start_at: string;
  readonly end_at: string;
  readonly maximum_span_ms: number;
}): void {
  const start = Date.parse(input.start_at);
  const end = Date.parse(input.end_at);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    !Number.isSafeInteger(input.maximum_span_ms) ||
    input.maximum_span_ms < 1 ||
    start >= end ||
    end - start > input.maximum_span_ms
  ) invalid("time range");
}

function freeBusy(input: Record<string, unknown>): CalendarFreeBusyInput {
  exact(input, [
    "start_at",
    "end_at",
    "participants",
    "include_external_calendars",
    "busy_only",
  ], ["authority_evidence"], "free/busy");
  const startAt = timestamp(input.start_at, "start_at");
  const endAt = timestamp(input.end_at, "end_at");
  assertCalendarTimeRange({
    start_at: startAt,
    end_at: endAt,
    maximum_span_ms: MAX_FREEBUSY_SPAN_MS,
  });
  return Object.freeze({
    capability_id: "feishu.calendar.freebusy.query",
    start_at: startAt,
    end_at: endAt,
    participants: participantRefs(input.participants, {
      allow_chat: false,
      minimum: 1,
    }),
    include_external_calendars: boolean(
      input.include_external_calendars,
      "include_external_calendars",
    ),
    busy_only: boolean(input.busy_only, "busy_only"),
    ...(input.authority_evidence === undefined
      ? {}
      : { authority_evidence: authorityEvidence(input.authority_evidence) }),
  });
}

function eventCreate(
  input: Record<string, unknown>,
): CalendarEventCreateInput {
  exact(input, [
    "calendar",
    "title",
    "start_at",
    "end_at",
    "time_zone",
    "attendees",
  ], [
    "description",
    "visibility",
    "attendee_ability",
    "reminders",
    "notify_attendees",
  ], "event create");
  const startAt = timestamp(input.start_at, "start_at");
  const endAt = timestamp(input.end_at, "end_at");
  assertCalendarTimeRange({
    start_at: startAt,
    end_at: endAt,
    maximum_span_ms: MAX_EVENT_DURATION_MS,
  });
  return Object.freeze({
    capability_id: "feishu.calendar.event.create",
    calendar: selector(input.calendar),
    title: string(input.title, "title", 512),
    ...(input.description === undefined
      ? {}
      : { description: string(input.description, "description", 16_384, 0) }),
    start_at: startAt,
    end_at: endAt,
    time_zone: timeZone(input.time_zone),
    attendees: participantRefs(input.attendees, {
      allow_chat: true,
      minimum: 0,
    }),
    ...(input.visibility === undefined
      ? {}
      : {
          visibility: optionalEnum<CalendarVisibility>(
            input.visibility,
            ["default", "public", "private"],
            "visibility",
          ),
        }),
    ...(input.attendee_ability === undefined
      ? {}
      : {
          attendee_ability: optionalEnum<CalendarAttendeeAbility>(
            input.attendee_ability,
            ["none", "can_invite_others", "can_modify"],
            "attendee ability",
          ),
        }),
    ...(input.reminders === undefined
      ? {}
      : { reminders: reminders(input.reminders) }),
    ...(input.notify_attendees === undefined
      ? {}
      : {
          notify_attendees: boolean(
            input.notify_attendees,
            "notify_attendees",
          ),
        }),
  });
}

function eventRead(
  input: Record<string, unknown>,
): CalendarEventReadInput {
  exact(input, ["event"], [], "event read");
  return Object.freeze({
    capability_id: "feishu.calendar.event.read",
    event: eventReference(input.event),
  });
}

function eventUpdate(
  input: Record<string, unknown>,
): CalendarEventUpdateInput {
  exact(input, [
    "event",
    "expected_provider_version",
    "field_mask",
    "changes",
  ], [], "event update");
  if (
    !Array.isArray(input.field_mask) ||
    input.field_mask.length < 1 ||
    input.field_mask.length > UPDATE_FIELDS.size
  ) invalid("field mask");
  const fieldMask = input.field_mask.map((item) =>
    string(item, "field mask", 64)
  );
  if (
    new Set(fieldMask).size !== fieldMask.length ||
    fieldMask.some((field) => !UPDATE_FIELDS.has(field))
  ) invalid("field mask");
  const changes = record(input.changes, "changes");
  if (
    Object.keys(changes).length !== fieldMask.length ||
    fieldMask.some((field) => !(field in changes)) ||
    Object.keys(changes).some((field) => !fieldMask.includes(field))
  ) invalid("changes");
  const normalizedChanges: Record<string, unknown> = {};
  for (const field of fieldMask) {
    switch (field) {
      case "title":
        normalizedChanges.title = string(changes.title, "title", 512);
        break;
      case "description":
        normalizedChanges.description = string(
          changes.description,
          "description",
          16_384,
          0,
        );
        break;
      case "start_at":
      case "end_at":
        normalizedChanges[field] = timestamp(changes[field], field);
        break;
      case "time_zone":
        normalizedChanges.time_zone = timeZone(changes.time_zone);
        break;
      case "visibility":
        normalizedChanges.visibility = optionalEnum<CalendarVisibility>(
          changes.visibility,
          ["default", "public", "private"],
          "visibility",
        );
        break;
      case "attendee_ability":
        normalizedChanges.attendee_ability =
          optionalEnum<CalendarAttendeeAbility>(
            changes.attendee_ability,
            ["none", "can_invite_others", "can_modify"],
            "attendee ability",
          );
        break;
      case "reminders":
        normalizedChanges.reminders = reminders(changes.reminders);
        break;
      case "notify_attendees":
        normalizedChanges.notify_attendees = boolean(
          changes.notify_attendees,
          "notify_attendees",
        );
        break;
    }
  }
  if (
    typeof normalizedChanges.start_at === "string" &&
    typeof normalizedChanges.end_at === "string"
  ) {
    assertCalendarTimeRange({
      start_at: normalizedChanges.start_at,
      end_at: normalizedChanges.end_at,
      maximum_span_ms: MAX_EVENT_DURATION_MS,
    });
  }
  return Object.freeze({
    capability_id: "feishu.calendar.event.update",
    event: eventReference(input.event),
    expected_provider_version: integer(
      input.expected_provider_version,
      "expected provider version",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    field_mask: Object.freeze(fieldMask),
    changes: Object.freeze(normalizedChanges),
  });
}

function attendeeMutation(
  capabilityId:
    | "feishu.calendar.attendees.add"
    | "feishu.calendar.attendees.remove",
  input: Record<string, unknown>,
): CalendarAttendeeMutationInput {
  exact(input, [
    "event",
    "expected_provider_version",
    "attendees",
    "notify_attendees",
  ], [], "attendee mutation");
  return Object.freeze({
    capability_id: capabilityId,
    event: eventReference(input.event),
    expected_provider_version: integer(
      input.expected_provider_version,
      "expected provider version",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    attendees: participantRefs(input.attendees, {
      allow_chat: true,
      minimum: 1,
    }),
    notify_attendees: boolean(
      input.notify_attendees,
      "notify_attendees",
    ),
  });
}

function eventDelete(
  input: Record<string, unknown>,
): CalendarEventDeleteInput {
  exact(input, [
    "event",
    "expected_provider_version",
    "confirmation_proof",
  ], [], "event delete");
  return Object.freeze({
    capability_id: "feishu.calendar.event.delete",
    event: eventReference(input.event),
    expected_provider_version: integer(
      input.expected_provider_version,
      "expected provider version",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    confirmation_proof: string(
      input.confirmation_proof,
      "confirmation proof",
      512,
    ),
  });
}

export function parseCalendarExecutionInput(
  capabilityId: string,
  input: Record<string, unknown>,
): CalendarExecutionInput {
  const value = record(input, "root");
  switch (capabilityId) {
    case "feishu.calendar.freebusy.query":
      return freeBusy(value);
    case "feishu.calendar.event.create":
      return eventCreate(value);
    case "feishu.calendar.event.read":
      return eventRead(value);
    case "feishu.calendar.event.update":
      return eventUpdate(value);
    case "feishu.calendar.attendees.add":
    case "feishu.calendar.attendees.remove":
      return attendeeMutation(capabilityId, value);
    case "feishu.calendar.event.delete":
      return eventDelete(value);
    default:
      invalid("unsupported capability");
  }
}
