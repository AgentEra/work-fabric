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
