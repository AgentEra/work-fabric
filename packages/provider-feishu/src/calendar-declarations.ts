import {
  canonicalCitizenDigest,
  type CitizenDeclaration,
} from "@work-fabric/network-citizen-spi";

const objectSchema = (
  required: readonly string[],
  properties: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  type: "object",
  additionalProperties: false,
  required,
  properties,
  ...extra,
});

const rfc3339 = {
  type: "string",
  format: "date-time",
  maxLength: 128,
};
const resourceUri = {
  type: "string",
  format: "uri",
  maxLength: 2_048,
};
const eventReference = objectSchema(["resource_uri"], {
  resource_uri: {
    ...resourceUri,
    pattern: "^feishu://calendar/[^/]+/events/[^/]+$",
  },
});
const calendarSelector = {
  oneOf: [
    objectSchema(["kind"], {
      kind: { const: "default_calendar" },
    }),
    objectSchema(["kind", "alias"], {
      kind: { const: "calendar_alias" },
      alias: { type: "string", minLength: 1, maxLength: 128 },
    }),
    objectSchema(["kind", "resource_uri"], {
      kind: { const: "resource_reference" },
      resource_uri: {
        ...resourceUri,
        pattern: "^feishu://calendar/[^/]+$",
      },
    }),
  ],
};
const attendeeRefs = {
  type: "array",
  maxItems: 100,
  uniqueItems: true,
  items: {
    type: "string",
    pattern: "^feishu://(?:user/open-id|chat)/[^/]+$",
    maxLength: 2_048,
  },
};
const userRefs = {
  ...attendeeRefs,
  minItems: 1,
  items: {
    type: "string",
    pattern: "^feishu://user/open-id/[^/]+$",
    maxLength: 2_048,
  },
};
const expectedProviderVersion = {
  type: "integer",
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
};
const provenance = objectSchema(["provider_family", "source"], {
  provider_family: { const: "feishu" },
  source: { type: "string", minLength: 1, maxLength: 128 },
});
const eventFacts = {
  event_resource_uri: {
    ...resourceUri,
    pattern: "^feishu://calendar/[^/]+/events/[^/]+$",
  },
  calendar_resource_uri: {
    ...resourceUri,
    pattern: "^feishu://calendar/[^/]+$",
  },
  event_id: { type: "string", minLength: 1, maxLength: 512 },
  url: { type: "string", format: "uri", maxLength: 2_048 },
  title: { type: "string", maxLength: 512 },
  description: { type: "string", maxLength: 16_384 },
  start_at: rfc3339,
  end_at: rfc3339,
  time_zone: { type: "string", minLength: 1, maxLength: 255 },
  provider_version: expectedProviderVersion,
  external_updated_at: rfc3339,
};
const attendeeOutcome = objectSchema([
  "resource_uri",
  "outcome",
], {
  resource_uri: resourceUri,
  outcome: {
    enum: ["added", "removed", "unchanged", "rejected"],
  },
  code: { type: "string", minLength: 1, maxLength: 128 },
});

const DEFINITIONS = Object.freeze({
  calendarFreeBusyInput: objectSchema([
    "start_at",
    "end_at",
    "participants",
    "include_external_calendars",
    "busy_only",
  ], {
    start_at: rfc3339,
    end_at: rfc3339,
    participants: userRefs,
    include_external_calendars: { type: "boolean" },
    busy_only: { type: "boolean" },
    authority_evidence: objectSchema([
      "capability_result_handoff_ids",
    ], {
      capability_result_handoff_ids: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        uniqueItems: true,
        items: {
          type: "string",
          minLength: 1,
          maxLength: 255,
          pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
        },
      },
    }),
  }),
  calendarFreeBusyOutput: objectSchema([
    "coverage",
    "participants",
    "unresolved_participants",
    "provenance",
  ], {
    coverage: objectSchema(["start_at", "end_at"], {
      start_at: rfc3339,
      end_at: rfc3339,
    }),
    participants: {
      type: "array",
      maxItems: 100,
      items: objectSchema(["resource_uri", "busy_intervals"], {
        resource_uri: resourceUri,
        busy_intervals: {
          type: "array",
          maxItems: 2_048,
          items: objectSchema(["start_at", "end_at"], {
            start_at: rfc3339,
            end_at: rfc3339,
          }),
        },
      }),
    },
    unresolved_participants: {
      type: "array",
      maxItems: 100,
      items: objectSchema(["resource_uri", "code"], {
        resource_uri: resourceUri,
        code: { type: "string", minLength: 1, maxLength: 128 },
      }),
    },
    provenance,
  }),
  calendarEventCreateInput: objectSchema([
    "calendar",
    "title",
    "start_at",
    "end_at",
    "time_zone",
    "attendees",
  ], {
    calendar: calendarSelector,
    title: { type: "string", minLength: 1, maxLength: 512 },
    description: { type: "string", maxLength: 16_384 },
    start_at: rfc3339,
    end_at: rfc3339,
    time_zone: { type: "string", minLength: 1, maxLength: 255 },
    attendees: attendeeRefs,
    visibility: { enum: ["default", "public", "private"] },
    attendee_ability: {
      enum: ["none", "can_invite_others", "can_modify"],
    },
    reminders: {
      type: "array",
      maxItems: 10,
      uniqueItems: true,
      items: { type: "integer", minimum: 0, maximum: 40_320 },
    },
    notify_attendees: { type: "boolean" },
  }),
  calendarEventCreateOutput: objectSchema([
    "event_resource_uri",
    "calendar_resource_uri",
    "event_id",
    "organizer_mode",
    "start_at",
    "end_at",
    "time_zone",
    "provider_version",
    "attendee_outcomes",
    "completion_state",
    "provenance",
  ], {
    ...eventFacts,
    organizer_mode: { const: "application" },
    attendee_outcomes: {
      type: "array",
      maxItems: 100,
      items: attendeeOutcome,
    },
    completion_state: { enum: ["complete", "partial"] },
    provenance,
  }),
  calendarEventReadInput: objectSchema(["event"], {
    event: eventReference,
  }),
  calendarEventReadOutput: objectSchema([
    "event_resource_uri",
    "calendar_resource_uri",
    "event_id",
    "title",
    "start_at",
    "end_at",
    "time_zone",
    "provider_version",
    "attendees",
    "provenance",
  ], {
    ...eventFacts,
    visibility: { enum: ["default", "public", "private"] },
    organizer_mode: { enum: ["application", "external"] },
    attendees: attendeeRefs,
    provenance,
  }),
  calendarEventUpdateInput: objectSchema([
    "event",
    "expected_provider_version",
    "field_mask",
    "changes",
  ], {
    event: eventReference,
    expected_provider_version: expectedProviderVersion,
    field_mask: {
      type: "array",
      minItems: 1,
      maxItems: 9,
      uniqueItems: true,
      items: {
        enum: [
          "title",
          "description",
          "start_at",
          "end_at",
          "time_zone",
          "visibility",
          "attendee_ability",
          "reminders",
          "notify_attendees",
        ],
      },
    },
    changes: objectSchema([], {
      title: { type: "string", minLength: 1, maxLength: 512 },
      description: { type: "string", maxLength: 16_384 },
      start_at: rfc3339,
      end_at: rfc3339,
      time_zone: { type: "string", minLength: 1, maxLength: 255 },
      visibility: { enum: ["default", "public", "private"] },
      attendee_ability: {
        enum: ["none", "can_invite_others", "can_modify"],
      },
      reminders: {
        type: "array",
        maxItems: 10,
        uniqueItems: true,
        items: { type: "integer", minimum: 0, maximum: 40_320 },
      },
      notify_attendees: { type: "boolean" },
    }, { minProperties: 1 }),
  }),
  calendarEventUpdateOutput: objectSchema([
    "event_resource_uri",
    "calendar_resource_uri",
    "event_id",
    "provider_version",
    "provenance",
  ], {
    ...eventFacts,
    provenance,
  }),
  calendarAttendeesInput: objectSchema([
    "event",
    "expected_provider_version",
    "attendees",
    "notify_attendees",
  ], {
    event: eventReference,
    expected_provider_version: expectedProviderVersion,
    attendees: { ...attendeeRefs, minItems: 1 },
    notify_attendees: { type: "boolean" },
  }),
  calendarAttendeesOutput: objectSchema([
    "event_resource_uri",
    "provider_version",
    "attendee_outcomes",
    "completion_state",
    "provenance",
  ], {
    event_resource_uri: eventFacts.event_resource_uri,
    provider_version: expectedProviderVersion,
    attendee_outcomes: {
      type: "array",
      maxItems: 100,
      items: attendeeOutcome,
    },
    completion_state: { enum: ["complete", "partial"] },
    provenance,
  }),
  calendarEventDeleteInput: objectSchema([
    "event",
    "expected_provider_version",
    "confirmation_proof",
  ], {
    event: eventReference,
    expected_provider_version: expectedProviderVersion,
    confirmation_proof: {
      type: "string",
      minLength: 1,
      maxLength: 512,
    },
  }),
  calendarEventDeleteOutput: objectSchema([
    "event_resource_uri",
    "deleted_at",
    "provider_version",
    "provenance",
  ], {
    event_resource_uri: eventFacts.event_resource_uri,
    deleted_at: rfc3339,
    provider_version: expectedProviderVersion,
    provenance,
  }),
});

function schema(name: keyof typeof DEFINITIONS) {
  const document = DEFINITIONS[name];
  return {
    uri: `urn:work-fabric:schema:feishu:${name}:1`,
    digest: canonicalCitizenDigest(document),
  } as const;
}

function capability(input: {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly input: keyof typeof DEFINITIONS;
  readonly output: keyof typeof DEFINITIONS;
  readonly risk: CitizenDeclaration["risk"];
  readonly operation_kind: "query" | "command" | "destructive";
  readonly confirmation?: CitizenDeclaration["confirmation"];
}): CitizenDeclaration {
  return Object.freeze({
    declaration_id: input.id,
    declaration_kind: "capability",
    version: "1.0.0",
    name: input.name,
    description: input.description,
    input_schema: schema(input.input),
    output_schema: schema(input.output),
    interaction_modes: ["asynchronous"] as const,
    risk: input.risk,
    confirmation: input.confirmation ?? "none",
    constraints: {
      single_target: true,
      maximum_content_bytes: 131_072,
      provider_output: "typed_facts_only",
      operation_kind: input.operation_kind,
    },
    extensions: {},
  });
}

export function feishuCalendarCapabilityDeclarations():
  readonly CitizenDeclaration[] {
  return Object.freeze([
    capability({
      id: "feishu.calendar.attendees.add",
      name: "Add Feishu Calendar attendees",
      description: "Add bounded authorized attendees to a Provider-owned event.",
      input: "calendarAttendeesInput",
      output: "calendarAttendeesOutput",
      risk: "medium",
      operation_kind: "command",
    }),
    capability({
      id: "feishu.calendar.attendees.remove",
      name: "Remove Feishu Calendar attendees",
      description:
        "Remove bounded attendees from a Provider-owned event.",
      input: "calendarAttendeesInput",
      output: "calendarAttendeesOutput",
      risk: "medium",
      operation_kind: "command",
    }),
    capability({
      id: "feishu.calendar.event.create",
      name: "Create Feishu Calendar event",
      description:
        "Create one bounded event on a registered calendar and add attendees.",
      input: "calendarEventCreateInput",
      output: "calendarEventCreateOutput",
      risk: "medium",
      operation_kind: "command",
    }),
    capability({
      id: "feishu.calendar.event.delete",
      name: "Delete Feishu Calendar event",
      description:
        "Delete one confirmed Provider-owned event and retain its tombstone.",
      input: "calendarEventDeleteInput",
      output: "calendarEventDeleteOutput",
      risk: "destructive",
      operation_kind: "destructive",
      confirmation: "explicit",
    }),
    capability({
      id: "feishu.calendar.event.read",
      name: "Read Feishu Calendar event",
      description: "Read bounded facts for one authorized event.",
      input: "calendarEventReadInput",
      output: "calendarEventReadOutput",
      risk: "low",
      operation_kind: "query",
    }),
    capability({
      id: "feishu.calendar.event.update",
      name: "Update Feishu Calendar event",
      description:
        "Update selected fields on one Provider-owned event at an expected version.",
      input: "calendarEventUpdateInput",
      output: "calendarEventUpdateOutput",
      risk: "medium",
      operation_kind: "command",
    }),
    capability({
      id: "feishu.calendar.freebusy.query",
      name: "Query Feishu Calendar free/busy",
      description:
        "Return bounded busy intervals for explicitly authorized users.",
      input: "calendarFreeBusyInput",
      output: "calendarFreeBusyOutput",
      risk: "low",
      operation_kind: "query",
    }),
  ]);
}

export function feishuCalendarSchemaDocuments():
  ReadonlyMap<string, unknown> {
  return new Map(Object.entries(DEFINITIONS).map(([name, body]) => [
    schema(name as keyof typeof DEFINITIONS).uri,
    structuredClone(body),
  ]));
}
