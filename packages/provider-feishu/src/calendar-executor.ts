import { createHash } from "node:crypto";

import type { RuntimeJsonObject } from "@work-fabric/agent-runtime-spi";

import type {
  CalendarAttendeeMutationInput,
  CalendarBinding,
  CalendarEventCreateInput,
  CalendarEventDeleteInput,
  CalendarEventReadInput,
  CalendarEventUpdateInput,
  CalendarExecutionInput,
  CalendarExecutionRecord,
  CalendarFreeBusyInput,
  FeishuCalendarAttendeeTarget,
  FeishuCalendarBackend,
  FeishuCalendarConfirmationVerifier,
  FeishuCalendarEventFacts,
  FeishuCalendarStore,
} from "./calendar-contracts.js";
import {
  FeishuCalendarResourceAdapter,
} from "./calendar-resource-adapter.js";
import {
  parseCalendarExecutionInput,
} from "./calendar-validation.js";
import {
  FeishuProviderBackendError,
  type FeishuCapabilityExecutionRequest,
  type FeishuCapabilityOutcome,
} from "./contracts.js";
import type {
  FeishuCapabilityExecutorLike,
} from "./execution-adapter.js";

export interface FeishuCalendarCapabilityExecutorOptions {
  readonly citizen_id: string;
  readonly endpoint_id: string;
  readonly backend: FeishuCalendarBackend;
  readonly store: FeishuCalendarStore;
  readonly confirmation: FeishuCalendarConfirmationVerifier;
  readonly clock?: () => string;
}

const REQUIRED_SCOPE = Object.freeze({
  "feishu.calendar.attendees.add": "calendar:attendee:write",
  "feishu.calendar.attendees.remove": "calendar:attendee:write",
  "feishu.calendar.event.create": "calendar:event:write",
  "feishu.calendar.event.delete": "calendar:event:delete",
  "feishu.calendar.event.read": "calendar:event:read",
  "feishu.calendar.event.update": "calendar:event:write",
  "feishu.calendar.freebusy.query": "calendar:freebusy:read",
} as const);

function rejected(code: string, message: string): FeishuCapabilityOutcome {
  return {
    outcome: "rejected",
    code,
    message,
    retryable: false,
  };
}

function backendFailure(error: unknown): FeishuCapabilityOutcome {
  if (error instanceof FeishuProviderBackendError) {
    if (error.retryable || error.code === "external_outcome_unknown") {
      return {
        outcome: "failed",
        code: error.code,
        message: "Feishu Calendar operation failed",
        retryable: error.retryable,
        ...(error.retry_after === undefined
          ? {}
          : { retry_after: error.retry_after }),
      };
    }
    return rejected(error.code, "Feishu Calendar operation was rejected");
  }
  return {
    outcome: "failed",
    code: "feishu_temporarily_unavailable",
    message: "Feishu Calendar operation failed",
    retryable: true,
  };
}

function digest(input: CalendarExecutionInput): `sha256:${string}` {
  return `sha256:${
    createHash("sha256").update(JSON.stringify(input)).digest("hex")
  }`;
}

function isBlockedUnknown(
  outcome: FeishuCapabilityOutcome | null,
): boolean {
  return outcome?.outcome === "failed" &&
    outcome.code === "external_outcome_unknown";
}

function eventTargets(
  resources: FeishuCalendarResourceAdapter,
  references: readonly string[],
): readonly FeishuCalendarAttendeeTarget[] {
  return references.map((resourceUri) =>
    resourceUri.startsWith("feishu://user/open-id/")
      ? {
          kind: "user" as const,
          open_id: resources.parseUser(resourceUri).open_id,
        }
      : {
          kind: "chat" as const,
          chat_id: resources.parseChat(resourceUri).chat_id,
        }
  );
}

export class FeishuCalendarCapabilityExecutor
  implements FeishuCapabilityExecutorLike {
  private readonly resources = new FeishuCalendarResourceAdapter();
  private readonly clock: () => string;

  constructor(
    private readonly options: FeishuCalendarCapabilityExecutorOptions,
  ) {
    if (
      options.citizen_id.length === 0 ||
      options.endpoint_id.length === 0
    ) throw new TypeError("Feishu Calendar executor identity is invalid");
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async execute(
    request: FeishuCapabilityExecutionRequest,
  ): Promise<FeishuCapabilityOutcome> {
    if (!(request.capability_id in REQUIRED_SCOPE)) {
      return rejected(
        "unsupported_capability",
        "Feishu Calendar capability is unavailable",
      );
    }
    let input: CalendarExecutionInput;
    try {
      input = parseCalendarExecutionInput(
        request.capability_id,
        request.input,
      );
    } catch {
      return rejected("invalid_input", "Feishu Calendar input is invalid");
    }
    const requiredScope = REQUIRED_SCOPE[
      request.capability_id as keyof typeof REQUIRED_SCOPE
    ];
    if (
      !request.delegation_scopes.includes(requiredScope) ||
      !Number.isFinite(Date.parse(request.delegation_expires_at)) ||
      Date.parse(request.delegation_expires_at) <= Date.parse(this.clock())
    ) {
      return rejected(
        "scope_not_granted",
        "Feishu Calendar scope is absent",
      );
    }
    try {
      switch (input.capability_id) {
        case "feishu.calendar.freebusy.query":
          return await this.freeBusy(request, input);
        case "feishu.calendar.event.read":
          return await this.readEvent(request, input);
        case "feishu.calendar.event.create":
          return await this.createEvent(request, input);
        case "feishu.calendar.event.update":
          return await this.updateEvent(request, input);
        case "feishu.calendar.attendees.add":
        case "feishu.calendar.attendees.remove":
          return await this.mutateAttendees(request, input);
        case "feishu.calendar.event.delete":
          return await this.deleteEvent(request, input);
      }
    } catch (error) {
      return backendFailure(error);
    }
  }

  private async freeBusy(
    request: FeishuCapabilityExecutionRequest,
    input: CalendarFreeBusyInput,
  ): Promise<FeishuCapabilityOutcome> {
    if (
      input.participants.some((resourceUri) =>
        !request.authority.allowed_target_refs.includes(resourceUri)
      )
    ) {
      return rejected(
        "target_not_allowed",
        "Calendar participant is not authorized",
      );
    }
    const byOpenId = new Map(
      input.participants.map((resourceUri) => [
        this.resources.parseUser(resourceUri).open_id,
        resourceUri,
      ]),
    );
    const result = await this.options.backend.queryFreeBusy({
      user_open_ids: [...byOpenId.keys()],
      start_at: input.start_at,
      end_at: input.end_at,
      include_external_calendars: input.include_external_calendars,
      busy_only: input.busy_only,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    const data: RuntimeJsonObject = {
      coverage: {
        start_at: result.start_at,
        end_at: result.end_at,
      },
      participants: result.participants.map((participant) => ({
        resource_uri:
          byOpenId.get(participant.open_id) ??
          this.resources.user(participant.open_id),
        busy_intervals: participant.busy_intervals.map((interval) => ({
          start_at: interval.start_at,
          end_at: interval.end_at,
        })),
      })),
      unresolved_participants: result.unresolved.map((participant) => ({
        resource_uri:
          byOpenId.get(participant.open_id) ??
          this.resources.user(participant.open_id),
        code: participant.code,
      })),
      provenance: {
        provider_family: "feishu",
        source: "feishu.calendar.freebusy",
      },
    };
    return { outcome: "succeeded", data, artifacts: [] };
  }

  private async readEvent(
    request: FeishuCapabilityExecutionRequest,
    input: CalendarEventReadInput,
  ): Promise<FeishuCapabilityOutcome> {
    const eventUri = input.event.resource_uri;
    const allowed = this.requireResource(request, eventUri);
    if (allowed !== null) return allowed;
    const parsed = this.resources.parseEvent(eventUri);
    const calendarUri = this.resources.calendar(parsed.calendar_id);
    const binding = await this.options.store.getBindingByResource(
      request.tenant_id,
      calendarUri,
    );
    if (binding === null || !binding.active) {
      return rejected(
        "calendar_not_registered",
        "Calendar is not registered",
      );
    }
    const event = await this.options.backend.readEvent({
      calendar_id: parsed.calendar_id,
      event_id: parsed.event_id,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    const ownership = await this.options.store.getEventOwnership(
      request.tenant_id,
      eventUri,
    );
    const data = this.eventData(
      eventUri,
      calendarUri,
      event,
      ownership?.provider_version,
      ownership === null ? "external" : "application",
    );
    return { outcome: "succeeded", data, artifacts: [] };
  }

  private async createEvent(
    request: FeishuCapabilityExecutionRequest,
    input: CalendarEventCreateInput,
  ): Promise<FeishuCapabilityOutcome> {
    if (
      input.attendees.some((resourceUri) =>
        !request.authority.allowed_target_refs.includes(resourceUri)
      )
    ) {
      return rejected(
        "target_not_allowed",
        "Calendar attendee is not authorized",
      );
    }
    const resolved = await this.resolveCalendar(request, input);
    if ("outcome" in resolved) return resolved;
    const binding = resolved;
    let execution = await this.beginExecution(request, input);
    const replay = this.replay(execution.record);
    if (replay !== null) return replay;

    if (execution.record.state === "started") {
      let created: FeishuCalendarEventFacts;
      try {
        created = await this.options.backend.createEvent({
          calendar_id: binding.external_calendar_id,
          title: input.title,
          ...(input.description === undefined
            ? {}
            : { description: input.description }),
          start_at: input.start_at,
          end_at: input.end_at,
          time_zone: input.time_zone,
          ...(input.visibility === undefined
            ? {}
            : { visibility: input.visibility }),
          ...(input.attendee_ability === undefined
            ? {}
            : { attendee_ability: input.attendee_ability }),
          ...(input.reminders === undefined
            ? {}
            : { reminders: input.reminders }),
          idempotency_key: request.idempotency_key,
          ...(request.signal === undefined
            ? {}
            : { signal: request.signal }),
        });
      } catch (error) {
        const failure = backendFailure(error);
        if (isBlockedUnknown(failure)) {
          await this.persistOutcome(execution.record, failure);
        }
        return failure;
      }
      if (created.calendar_id !== binding.external_calendar_id) {
        throw new FeishuProviderBackendError(
          "feishu_response_invalid",
          true,
        );
      }
      const eventUri = this.resources.event(
        created.calendar_id,
        created.event_id,
      );
      await this.options.store.putEventOwnership({
        tenant_id: request.tenant_id,
        event_resource_uri: eventUri,
        calendar_resource_uri: binding.resource_uri,
        external_event_id: created.event_id,
        citizen_id: this.options.citizen_id,
        endpoint_id: this.options.endpoint_id,
        original_handoff_id: request.original_handoff_id,
        initiating_actor_id: request.represented_actor_id,
        create_idempotency_key: request.idempotency_key,
        provider_version: 1,
        external_updated_at: created.updated_at ?? null,
        deleted_at: null,
      });
      const provisional: FeishuCapabilityOutcome = {
        outcome: "succeeded",
        data: {
          ...this.eventData(
            eventUri,
            binding.resource_uri,
            created,
            1,
            "application",
          ),
          attendee_outcomes: [],
          completion_state: input.attendees.length === 0
            ? "complete"
            : "partial",
        },
        artifacts: [],
      };
      execution = {
        created: execution.created,
        record: await this.options.store.checkpoint({
          tenant_id: request.tenant_id,
          idempotency_key: request.idempotency_key,
          expected_version: execution.record.version,
          state: "event_created",
          event_resource_uri: eventUri,
          outcome: provisional,
          updated_at: this.clock(),
        }),
      };
    }

    if (execution.record.state === "event_created") {
      if (isBlockedUnknown(execution.record.outcome)) {
        return execution.record.outcome!;
      }
      const base = execution.record.outcome;
      if (base?.outcome !== "succeeded") {
        throw new Error("Calendar create checkpoint is invalid");
      }
      let attendeeOutcomes: readonly RuntimeJsonObject[] = [];
      let completionState: "complete" | "partial" = "complete";
      if (input.attendees.length > 0) {
        const targets = eventTargets(this.resources, input.attendees);
        try {
          const result = await this.options.backend.addAttendees({
            calendar_id: binding.external_calendar_id,
            event_id: this.resources.parseEvent(
              execution.record.event_resource_uri!,
            ).event_id,
            attendees: targets,
            need_notification: input.notify_attendees ?? false,
            ...(request.signal === undefined
              ? {}
              : { signal: request.signal }),
          });
          const outcomes = new Map(result.attendees.map((attendee) => [
            `${attendee.kind}:${attendee.external_id}`,
            attendee.outcome,
          ]));
          attendeeOutcomes = input.attendees.map((resourceUri, index) => ({
            resource_uri: resourceUri,
            outcome: outcomes.get(
              `${targets[index]!.kind}:${
                targets[index]!.kind === "user"
                  ? targets[index]!.open_id
                  : targets[index]!.chat_id
              }`,
            ) ?? "rejected",
            ...(outcomes.has(
                `${targets[index]!.kind}:${
                  targets[index]!.kind === "user"
                    ? targets[index]!.open_id
                    : targets[index]!.chat_id
                }`,
              )
              ? {}
              : { code: "attendee_result_missing" }),
          }));
          completionState = attendeeOutcomes.some((outcome) =>
              outcome.outcome === "rejected"
            )
            ? "partial"
            : "complete";
        } catch (error) {
          const failure = backendFailure(error);
          if (isBlockedUnknown(failure)) {
            await this.persistOutcome(execution.record, failure);
            return failure;
          }
          if (failure.outcome === "failed" && failure.retryable) {
            return failure;
          }
          attendeeOutcomes = input.attendees.map((resourceUri) => ({
            resource_uri: resourceUri,
            outcome: "rejected",
            code: failure.outcome === "succeeded"
              ? "attendee_operation_rejected"
              : failure.code,
          }));
          completionState = "partial";
        }
      }
      const final: FeishuCapabilityOutcome = {
        outcome: "succeeded",
        data: {
          ...base.data,
          attendee_outcomes: attendeeOutcomes,
          completion_state: completionState,
        },
        artifacts: [],
      };
      execution = {
        created: execution.created,
        record: await this.options.store.checkpoint({
          tenant_id: request.tenant_id,
          idempotency_key: request.idempotency_key,
          expected_version: execution.record.version,
          state: "attendees_applied",
          outcome: final,
          updated_at: this.clock(),
        }),
      };
    }

    if (execution.record.state === "attendees_applied") {
      execution = {
        created: execution.created,
        record: await this.options.store.checkpoint({
          tenant_id: request.tenant_id,
          idempotency_key: request.idempotency_key,
          expected_version: execution.record.version,
          state: "completed",
          outcome: execution.record.outcome!,
          updated_at: this.clock(),
        }),
      };
    }
    if (execution.record.outcome === null) {
      throw new Error("Calendar create outcome is missing");
    }
    return execution.record.outcome;
  }

  private async updateEvent(
    request: FeishuCapabilityExecutionRequest,
    input: CalendarEventUpdateInput,
  ): Promise<FeishuCapabilityOutcome> {
    const started = await this.beginExecution(request, input);
    const replay = this.replay(started.record);
    if (replay !== null) return replay;
    const owned = await this.ownedEvent(
      request,
      input.event.resource_uri,
      input.expected_provider_version,
    );
    if ("outcome" in owned) return owned;
    const parsed = this.resources.parseEvent(input.event.resource_uri);
    const current = await this.options.backend.readEvent({
      calendar_id: parsed.calendar_id,
      event_id: parsed.event_id,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (
      owned.external_updated_at !== null &&
      current.updated_at !== undefined &&
      current.updated_at !== owned.external_updated_at
    ) {
      return rejected(
        "external_concurrent_change",
        "Calendar event changed outside the Provider",
      );
    }
    let updated: FeishuCalendarEventFacts;
    try {
      updated = await this.options.backend.updateEvent({
        calendar_id: parsed.calendar_id,
        event_id: parsed.event_id,
        field_mask: input.field_mask,
        changes: input.changes,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch (error) {
      const failure = backendFailure(error);
      if (isBlockedUnknown(failure)) {
        await this.persistOutcome(started.record, failure);
      }
      return failure;
    }
    const ownership = await this.options.store.updateEventVersion({
      tenant_id: request.tenant_id,
      event_resource_uri: input.event.resource_uri,
      expected_version: input.expected_provider_version,
      external_updated_at: updated.updated_at ?? null,
    });
    const outcome: FeishuCapabilityOutcome = {
      outcome: "succeeded",
      data: this.eventData(
        input.event.resource_uri,
        ownership.calendar_resource_uri,
        updated,
        ownership.provider_version,
        "application",
      ),
      artifacts: [],
    };
    await this.completeExecution(started.record, outcome);
    return outcome;
  }

  private async mutateAttendees(
    request: FeishuCapabilityExecutionRequest,
    input: CalendarAttendeeMutationInput,
  ): Promise<FeishuCapabilityOutcome> {
    if (
      input.attendees.some((resourceUri) =>
        !request.authority.allowed_target_refs.includes(resourceUri)
      )
    ) {
      return rejected(
        "target_not_allowed",
        "Calendar attendee is not authorized",
      );
    }
    const started = await this.beginExecution(request, input);
    const replay = this.replay(started.record);
    if (replay !== null) return replay;
    const owned = await this.ownedEvent(
      request,
      input.event.resource_uri,
      input.expected_provider_version,
    );
    if ("outcome" in owned) return owned;
    const parsed = this.resources.parseEvent(input.event.resource_uri);
    const targets = eventTargets(this.resources, input.attendees);
    let result;
    try {
      result = input.capability_id === "feishu.calendar.attendees.add"
        ? await this.options.backend.addAttendees({
            calendar_id: parsed.calendar_id,
            event_id: parsed.event_id,
            attendees: targets,
            need_notification: input.notify_attendees,
            ...(request.signal === undefined
              ? {}
              : { signal: request.signal }),
          })
        : await this.options.backend.removeAttendees({
            calendar_id: parsed.calendar_id,
            event_id: parsed.event_id,
            attendees: targets,
            need_notification: input.notify_attendees,
            ...(request.signal === undefined
              ? {}
              : { signal: request.signal }),
          });
    } catch (error) {
      const failure = backendFailure(error);
      if (isBlockedUnknown(failure)) {
        await this.persistOutcome(started.record, failure);
      }
      return failure;
    }
    const ownership = await this.options.store.updateEventVersion({
      tenant_id: request.tenant_id,
      event_resource_uri: input.event.resource_uri,
      expected_version: input.expected_provider_version,
      external_updated_at: owned.external_updated_at,
    });
    const byTarget = new Map(result.attendees.map((attendee) => [
      `${attendee.kind}:${attendee.external_id}`,
      attendee.outcome,
    ]));
    const attendeeOutcomes = input.attendees.map((resourceUri, index) => {
      const target = targets[index]!;
      const id = target.kind === "user" ? target.open_id : target.chat_id;
      const resultOutcome = byTarget.get(`${target.kind}:${id}`);
      return {
        resource_uri: resourceUri,
        outcome: resultOutcome ?? "rejected",
        ...(resultOutcome === undefined
          ? { code: "attendee_result_missing" }
          : {}),
      };
    });
    const outcome: FeishuCapabilityOutcome = {
      outcome: "succeeded",
      data: {
        event_resource_uri: input.event.resource_uri,
        provider_version: ownership.provider_version,
        attendee_outcomes: attendeeOutcomes,
        completion_state: attendeeOutcomes.some((item) =>
            item.outcome === "rejected"
          )
          ? "partial"
          : "complete",
        provenance: {
          provider_family: "feishu",
          source: "feishu.calendar.attendees",
        },
      },
      artifacts: [],
    };
    await this.completeExecution(started.record, outcome);
    return outcome;
  }

  private async deleteEvent(
    request: FeishuCapabilityExecutionRequest,
    input: CalendarEventDeleteInput,
  ): Promise<FeishuCapabilityOutcome> {
    const allowed = this.requireResource(request, input.event.resource_uri);
    if (allowed !== null) return allowed;
    let execution = await this.beginExecution(request, input);
    const replay = this.replay(execution.record);
    if (replay !== null) return replay;
    const ownership = await this.options.store.getEventOwnership(
      request.tenant_id,
      input.event.resource_uri,
    );
    if (
      ownership === null ||
      ownership.initiating_actor_id !== request.represented_actor_id
    ) {
      return rejected("event_not_owned", "Calendar event is not Provider-owned");
    }
    if (ownership.deleted_at !== null) {
      const outcome = this.deletedOutcome(
        input.event.resource_uri,
        ownership.provider_version,
        ownership.deleted_at,
      );
      await this.completeExecution(execution.record, outcome);
      return outcome;
    }
    if (ownership.provider_version !== input.expected_provider_version) {
      return rejected(
        "event_version_conflict",
        "Calendar event version changed",
      );
    }
    if (
      !request.authority.confirmation_proof_refs.includes(
        input.confirmation_proof,
      )
    ) {
      return rejected(
        "confirmation_required",
        "Calendar event deletion requires confirmation",
      );
    }
    if (execution.record.state === "started") {
      const normalizedDigest = digest(input);
      const consumed = await this.options.confirmation.consume({
        tenant_id: request.tenant_id,
        human_actor_id: request.represented_actor_id,
        capability_id: "feishu.calendar.event.delete",
        event_resource_uri: input.event.resource_uri,
        normalized_input_digest: normalizedDigest,
        proof_reference: input.confirmation_proof,
      });
      if (!consumed) {
        return rejected(
          "confirmation_invalid",
          "Calendar event deletion confirmation is invalid",
        );
      }
      execution = {
        created: execution.created,
        record: await this.options.store.checkpoint({
          tenant_id: request.tenant_id,
          idempotency_key: request.idempotency_key,
          expected_version: execution.record.version,
          state: "confirmation_consumed",
          outcome: {
            outcome: "failed",
            code: "confirmation_consumed",
            message: "Destructive confirmation was consumed",
            retryable: true,
          },
          updated_at: this.clock(),
        }),
      };
    }
    const parsed = this.resources.parseEvent(input.event.resource_uri);
    let deletion;
    try {
      deletion = await this.options.backend.deleteEvent({
        calendar_id: parsed.calendar_id,
        event_id: parsed.event_id,
        need_notification: true,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch (error) {
      const failure = backendFailure(error);
      if (isBlockedUnknown(failure)) {
        await this.persistOutcome(execution.record, failure);
      }
      return failure;
    }
    const tombstone = await this.options.store.markEventDeleted({
      tenant_id: request.tenant_id,
      event_resource_uri: input.event.resource_uri,
      expected_version: input.expected_provider_version,
      deleted_at: deletion.deleted_at,
    });
    const outcome = this.deletedOutcome(
      input.event.resource_uri,
      tombstone.provider_version,
      deletion.deleted_at,
    );
    await this.completeExecution(execution.record, outcome);
    return outcome;
  }

  private requireResource(
    request: FeishuCapabilityExecutionRequest,
    resourceUri: string,
  ): FeishuCapabilityOutcome | null {
    return (request.authority.allowed_resource_refs ?? []).includes(resourceUri)
      ? null
      : rejected(
        "resource_not_allowed",
        "Calendar resource is not authorized",
      );
  }

  private async resolveCalendar(
    request: FeishuCapabilityExecutionRequest,
    input: CalendarEventCreateInput,
  ): Promise<CalendarBinding | FeishuCapabilityOutcome> {
    let binding: CalendarBinding | null;
    switch (input.calendar.kind) {
      case "default_calendar":
        binding = await this.options.store.getDefault(request.tenant_id);
        break;
      case "calendar_alias":
        binding = await this.options.store.getBinding(
          request.tenant_id,
          input.calendar.alias,
        );
        break;
      case "resource_reference": {
        const allowed = this.requireResource(
          request,
          input.calendar.resource_uri,
        );
        if (allowed !== null) return allowed;
        binding = await this.options.store.getBindingByResource(
          request.tenant_id,
          input.calendar.resource_uri,
        );
        break;
      }
    }
    if (binding === null || !binding.active) {
      return rejected(
        "calendar_not_registered",
        "Calendar is not registered",
      );
    }
    if (binding.access_role !== "owner" && binding.access_role !== "writer") {
      return rejected(
        "calendar_not_writable",
        "Calendar is not writable",
      );
    }
    return binding;
  }

  private async ownedEvent(
    request: FeishuCapabilityExecutionRequest,
    eventUri: string,
    expectedVersion: number,
  ) {
    const allowed = this.requireResource(request, eventUri);
    if (allowed !== null) return allowed;
    const ownership = await this.options.store.getEventOwnership(
      request.tenant_id,
      eventUri,
    );
    if (
      ownership === null ||
      ownership.deleted_at !== null ||
      ownership.initiating_actor_id !== request.represented_actor_id
    ) {
      return rejected(
        "event_not_owned",
        "Calendar event is not Provider-owned",
      );
    }
    if (ownership.provider_version !== expectedVersion) {
      return rejected(
        "event_version_conflict",
        "Calendar event version changed",
      );
    }
    return ownership;
  }

  private beginExecution(
    request: FeishuCapabilityExecutionRequest,
    input: CalendarExecutionInput,
  ) {
    return this.options.store.beginExecution({
      tenant_id: request.tenant_id,
      idempotency_key: request.idempotency_key,
      capability_id: request.capability_id,
      input_digest: digest(input),
      created_at: this.clock(),
    });
  }

  private replay(
    record: CalendarExecutionRecord,
  ): FeishuCapabilityOutcome | null {
    if (
      record.outcome !== null &&
      (
        record.state === "completed" ||
        isBlockedUnknown(record.outcome)
      )
    ) return record.outcome;
    return null;
  }

  private async persistOutcome(
    record: CalendarExecutionRecord,
    outcome: FeishuCapabilityOutcome,
  ): Promise<void> {
    await this.options.store.checkpoint({
      tenant_id: record.tenant_id,
      idempotency_key: record.idempotency_key,
      expected_version: record.version,
      state: record.state,
      ...(record.event_resource_uri === null
        ? {}
        : { event_resource_uri: record.event_resource_uri }),
      outcome,
      updated_at: this.clock(),
    });
  }

  private async completeExecution(
    record: CalendarExecutionRecord,
    outcome: FeishuCapabilityOutcome,
  ): Promise<void> {
    await this.options.store.checkpoint({
      tenant_id: record.tenant_id,
      idempotency_key: record.idempotency_key,
      expected_version: record.version,
      state: "completed",
      ...(record.event_resource_uri === null
        ? {}
        : { event_resource_uri: record.event_resource_uri }),
      outcome,
      updated_at: this.clock(),
    });
  }

  private eventData(
    eventUri: string,
    calendarUri: string,
    event: FeishuCalendarEventFacts,
    providerVersion: number | undefined,
    organizerMode: "application" | "external",
  ): RuntimeJsonObject {
    return {
      event_resource_uri: eventUri,
      calendar_resource_uri: calendarUri,
      event_id: event.event_id,
      title: event.title,
      ...(event.description === undefined
        ? {}
        : { description: event.description }),
      start_at: event.start_at,
      end_at: event.end_at,
      time_zone: event.time_zone,
      ...(event.visibility === undefined
        ? {}
        : { visibility: event.visibility }),
      organizer_mode: organizerMode,
      attendees: event.attendees.map((attendee) =>
        attendee.kind === "user"
          ? this.resources.user(attendee.open_id)
          : this.resources.chat(attendee.chat_id)
      ),
      ...(providerVersion === undefined
        ? {}
        : { provider_version: providerVersion }),
      ...(event.url === undefined ? {} : { url: event.url }),
      ...(event.updated_at === undefined
        ? {}
        : { external_updated_at: event.updated_at }),
      provenance: {
        provider_family: "feishu",
        source: "feishu.calendar.event",
      },
    };
  }

  private deletedOutcome(
    eventUri: string,
    providerVersion: number,
    deletedAt: string,
  ): FeishuCapabilityOutcome {
    return {
      outcome: "succeeded",
      data: {
        event_resource_uri: eventUri,
        deleted_at: deletedAt,
        provider_version: providerVersion,
        provenance: {
          provider_family: "feishu",
          source: "feishu.calendar.event",
        },
      },
      artifacts: [],
    };
  }
}
