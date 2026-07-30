export type CalendarSelector =
  | { readonly kind: "default_calendar" }
  | { readonly kind: "calendar_alias"; readonly alias: string }
  | {
      readonly kind: "resource_reference";
      readonly resource_uri: string;
    };

export interface CalendarAuthorityEvidenceInput {
  readonly capability_result_handoff_ids: readonly string[];
}

export interface CalendarEventAuthorityEvidenceInput
  extends CalendarAuthorityEvidenceInput {
  readonly session_origin_handoff_id: string;
  readonly confirmation_handoff_id: string;
  readonly proposal_digest: `sha256:${string}`;
}

export interface CalendarEventReference {
  readonly resource_uri: string;
}

export type CalendarAttendeeAbility =
  | "none"
  | "can_invite_others"
  | "can_modify";

export type CalendarVisibility =
  | "default"
  | "public"
  | "private";

export interface CalendarFreeBusyInput {
  readonly capability_id: "feishu.calendar.freebusy.query";
  readonly start_at: string;
  readonly end_at: string;
  readonly participants: readonly string[];
  readonly include_external_calendars: boolean;
  readonly busy_only: boolean;
  readonly authority_evidence?: CalendarAuthorityEvidenceInput;
}

export interface CalendarEventCreateInput {
  readonly capability_id: "feishu.calendar.event.create";
  readonly calendar: CalendarSelector;
  readonly title: string;
  readonly description?: string;
  readonly start_at: string;
  readonly end_at: string;
  readonly time_zone: string;
  readonly attendees: readonly string[];
  readonly visibility?: CalendarVisibility;
  readonly attendee_ability?: CalendarAttendeeAbility;
  readonly reminders?: readonly number[];
  readonly notify_attendees?: boolean;
  readonly authority_evidence?: CalendarEventAuthorityEvidenceInput;
}

export interface CalendarEventReadInput {
  readonly capability_id: "feishu.calendar.event.read";
  readonly event: CalendarEventReference;
}

export interface CalendarEventUpdateInput {
  readonly capability_id: "feishu.calendar.event.update";
  readonly event: CalendarEventReference;
  readonly expected_provider_version: number;
  readonly field_mask: readonly string[];
  readonly changes: Readonly<Record<string, unknown>>;
}

export interface CalendarAttendeeMutationInput {
  readonly capability_id:
    | "feishu.calendar.attendees.add"
    | "feishu.calendar.attendees.remove";
  readonly event: CalendarEventReference;
  readonly expected_provider_version: number;
  readonly attendees: readonly string[];
  readonly notify_attendees: boolean;
}

export interface CalendarEventDeleteInput {
  readonly capability_id: "feishu.calendar.event.delete";
  readonly event: CalendarEventReference;
  readonly expected_provider_version: number;
  readonly confirmation_proof: string;
}

export type CalendarExecutionInput =
  | CalendarFreeBusyInput
  | CalendarEventCreateInput
  | CalendarEventReadInput
  | CalendarEventUpdateInput
  | CalendarAttendeeMutationInput
  | CalendarEventDeleteInput;

export interface CalendarEventOwnership {
  readonly tenant_id: string;
  readonly event_resource_uri: string;
  readonly calendar_resource_uri: string;
  readonly external_event_id: string;
  readonly citizen_id: string;
  readonly endpoint_id: string;
  readonly original_handoff_id: string;
  readonly initiating_actor_id: string;
  readonly create_idempotency_key: string;
  readonly provider_version: number;
  readonly external_updated_at: string | null;
  readonly deleted_at: string | null;
}

export interface CalendarBinding {
  readonly tenant_id: string;
  readonly alias: string;
  readonly resource_uri: string;
  readonly external_calendar_id: string;
  readonly calendar_type: "primary" | "shared";
  readonly access_role: "writer" | "owner";
  readonly is_default: boolean;
  readonly active: boolean;
  readonly bound_by_principal_id: string;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export type CalendarExecutionState =
  | "started"
  | "confirmation_consumed"
  | "event_created"
  | "attendees_applied"
  | "completed";

export interface CalendarExecutionRecord {
  readonly tenant_id: string;
  readonly idempotency_key: string;
  readonly capability_id: string;
  readonly input_digest: `sha256:${string}`;
  readonly state: CalendarExecutionState;
  readonly event_resource_uri: string | null;
  readonly outcome: FeishuCapabilityOutcome | null;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface FeishuCalendarRegistry {
  bind(
    input: Omit<CalendarBinding, "version">,
    expectedVersion: number,
  ): Promise<CalendarBinding>;
  getBinding(
    tenantId: string,
    alias: string,
  ): Promise<CalendarBinding | null>;
  getBindingByResource(
    tenantId: string,
    resourceUri: string,
  ): Promise<CalendarBinding | null>;
  getDefault(tenantId: string): Promise<CalendarBinding | null>;
  listBindings(input: {
    readonly tenant_id: string;
    readonly after_alias?: string;
    readonly limit: number;
  }): Promise<{
    readonly items: readonly CalendarBinding[];
    readonly next_after_alias: string | null;
  }>;
  setDefault(input: {
    readonly tenant_id: string;
    readonly alias: string;
    readonly expected_version: number;
    readonly updated_at: string;
  }): Promise<CalendarBinding>;
}

export interface FeishuCalendarExecutionStore {
  beginExecution(input: {
    readonly tenant_id: string;
    readonly idempotency_key: string;
    readonly capability_id: string;
    readonly input_digest: `sha256:${string}`;
    readonly created_at: string;
  }): Promise<{
    readonly created: boolean;
    readonly record: CalendarExecutionRecord;
  }>;
  checkpoint(input: {
    readonly tenant_id: string;
    readonly idempotency_key: string;
    readonly expected_version: number;
    readonly state: CalendarExecutionState;
    readonly event_resource_uri?: string;
    readonly outcome?: FeishuCapabilityOutcome;
    readonly updated_at: string;
  }): Promise<CalendarExecutionRecord>;
  getExecution(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<CalendarExecutionRecord | null>;
}

export interface FeishuCalendarEventStore {
  putEventOwnership(input: CalendarEventOwnership): Promise<void>;
  getEventOwnership(
    tenantId: string,
    eventResourceUri: string,
  ): Promise<CalendarEventOwnership | null>;
  getEventOwnershipByCreateKey(
    tenantId: string,
    createIdempotencyKey: string,
  ): Promise<CalendarEventOwnership | null>;
  updateEventVersion(input: {
    readonly tenant_id: string;
    readonly event_resource_uri: string;
    readonly expected_version: number;
    readonly external_updated_at: string | null;
  }): Promise<CalendarEventOwnership>;
  markEventDeleted(input: {
    readonly tenant_id: string;
    readonly event_resource_uri: string;
    readonly expected_version: number;
    readonly deleted_at: string;
  }): Promise<CalendarEventOwnership>;
}

export interface FeishuCalendarStore
  extends FeishuCalendarRegistry,
    FeishuCalendarExecutionStore,
    FeishuCalendarEventStore {
  close(): Promise<void>;
}

export interface FeishuCalendarFacts {
  readonly calendar_id: string;
  readonly summary: string;
  readonly description?: string;
  readonly calendar_type: "primary" | "shared";
  readonly access_role: "writer" | "owner";
}

export interface FeishuBusyInterval {
  readonly start_at: string;
  readonly end_at: string;
}

export interface FeishuFreeBusyFacts {
  readonly start_at: string;
  readonly end_at: string;
  readonly participants: readonly {
    readonly open_id: string;
    readonly busy_intervals: readonly FeishuBusyInterval[];
  }[];
  readonly unresolved: readonly {
    readonly open_id: string;
    readonly code: string;
  }[];
}

export interface FeishuCalendarEventFacts {
  readonly calendar_id: string;
  readonly event_id: string;
  readonly title: string;
  readonly description?: string;
  readonly start_at: string;
  readonly end_at: string;
  readonly time_zone: string;
  readonly visibility?: string;
  readonly attendee_ability?: string;
  readonly attendees: readonly FeishuCalendarAttendeeTarget[];
  readonly url?: string;
  readonly created_at?: string;
  readonly updated_at?: string;
}

export type FeishuCalendarAttendeeTarget =
  | { readonly kind: "user"; readonly open_id: string }
  | { readonly kind: "chat"; readonly chat_id: string };

export interface FeishuAttendeeMutationFacts {
  readonly attendees: readonly {
    readonly kind: "user" | "chat";
    readonly external_id: string;
    readonly outcome: "added" | "removed";
  }[];
}

export interface FeishuDeleteEventFacts {
  readonly calendar_id: string;
  readonly event_id: string;
  readonly deleted_at: string;
}

export interface FeishuCalendarBackend {
  getCalendar(input: {
    readonly calendar_id: string;
    readonly signal?: AbortSignal;
  }): Promise<FeishuCalendarFacts>;
  createSharedCalendar(input: {
    readonly summary: string;
    readonly description?: string;
    readonly permissions?: "private" | "show_only_free_busy" | "public";
    readonly signal?: AbortSignal;
  }): Promise<FeishuCalendarFacts>;
  queryFreeBusy(input: {
    readonly user_open_ids: readonly string[];
    readonly start_at: string;
    readonly end_at: string;
    readonly include_external_calendars: boolean;
    readonly busy_only: boolean;
    readonly signal?: AbortSignal;
  }): Promise<FeishuFreeBusyFacts>;
  createEvent(input: {
    readonly calendar_id: string;
    readonly title: string;
    readonly description?: string;
    readonly start_at: string;
    readonly end_at: string;
    readonly time_zone: string;
    readonly visibility?: CalendarVisibility;
    readonly attendee_ability?: CalendarAttendeeAbility;
    readonly reminders?: readonly number[];
    readonly idempotency_key: string;
    readonly signal?: AbortSignal;
  }): Promise<FeishuCalendarEventFacts>;
  readEvent(input: {
    readonly calendar_id: string;
    readonly event_id: string;
    readonly signal?: AbortSignal;
  }): Promise<FeishuCalendarEventFacts>;
  updateEvent(input: {
    readonly calendar_id: string;
    readonly event_id: string;
    readonly field_mask: readonly string[];
    readonly changes: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  }): Promise<FeishuCalendarEventFacts>;
  addAttendees(input: {
    readonly calendar_id: string;
    readonly event_id: string;
    readonly attendees: readonly FeishuCalendarAttendeeTarget[];
    readonly need_notification: boolean;
    readonly signal?: AbortSignal;
  }): Promise<FeishuAttendeeMutationFacts>;
  removeAttendees(input: {
    readonly calendar_id: string;
    readonly event_id: string;
    readonly attendees: readonly FeishuCalendarAttendeeTarget[];
    readonly need_notification: boolean;
    readonly signal?: AbortSignal;
  }): Promise<FeishuAttendeeMutationFacts>;
  deleteEvent(input: {
    readonly calendar_id: string;
    readonly event_id: string;
    readonly need_notification: boolean;
    readonly signal?: AbortSignal;
  }): Promise<FeishuDeleteEventFacts>;
}

export interface FeishuCalendarConfirmationVerifier {
  consume(input: {
    readonly tenant_id: string;
    readonly human_actor_id: string;
    readonly capability_id: "feishu.calendar.event.delete";
    readonly event_resource_uri: string;
    readonly normalized_input_digest: `sha256:${string}`;
    readonly proof_reference: string;
  }): Promise<boolean>;
}
import type {
  FeishuCapabilityOutcome,
} from "./contracts.js";
