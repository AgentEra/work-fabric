import type { RuntimeJsonObject } from "@work-fabric/agent-runtime-spi";

import type {
  CalendarEventReadInput,
  CalendarFreeBusyInput,
  FeishuCalendarBackend,
  FeishuCalendarConfirmationVerifier,
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
  "feishu.calendar.freebusy.query": "calendar:freebusy:read",
  "feishu.calendar.event.read": "calendar:event:read",
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
    let input;
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
      if (input.capability_id === "feishu.calendar.freebusy.query") {
        return await this.freeBusy(request, input);
      }
      if (input.capability_id === "feishu.calendar.event.read") {
        return await this.readEvent(request, input);
      }
      return rejected(
        "unsupported_capability",
        "Feishu Calendar capability is unavailable",
      );
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
    if (
      !(request.authority.allowed_resource_refs ?? []).includes(eventUri)
    ) {
      return rejected(
        "resource_not_allowed",
        "Calendar event is not authorized",
      );
    }
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
    const attendees = event.attendees.map((attendee) =>
      attendee.kind === "user"
        ? this.resources.user(attendee.open_id)
        : this.resources.chat(attendee.chat_id)
    );
    const data: RuntimeJsonObject = {
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
      organizer_mode: ownership === null ? "external" : "application",
      attendees,
      ...(ownership === null
        ? {}
        : { provider_version: ownership.provider_version }),
      ...(event.url === undefined ? {} : { url: event.url }),
      ...(event.updated_at === undefined
        ? {}
        : { external_updated_at: event.updated_at }),
      provenance: {
        provider_family: "feishu",
        source: "feishu.calendar.event",
      },
    };
    return { outcome: "succeeded", data, artifacts: [] };
  }
}
