import { createHash } from "node:crypto";

import type {
  CalendarBinding,
  FeishuCalendarBackend,
  FeishuCalendarFacts,
  FeishuCalendarStore,
} from "./calendar-contracts.js";
import { FeishuCalendarResourceAdapter } from "./calendar-resource-adapter.js";
import { FeishuProviderBackendError } from "./contracts.js";

export interface FeishuCalendarAdministrationPort {
  bindExisting(input: {
    readonly tenant_id: string;
    readonly alias: string;
    readonly external_calendar_id: string;
    readonly make_default: boolean;
    readonly operator_principal_id: string;
  }): Promise<CalendarBinding>;
  createAndBind(input: {
    readonly tenant_id: string;
    readonly alias: string;
    readonly summary: string;
    readonly description?: string;
    readonly permissions: "private" | "show_only_free_busy" | "public";
    readonly make_default: boolean;
    readonly operator_principal_id: string;
  }): Promise<CalendarBinding>;
}

export class FeishuCalendarAdministrationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "FeishuCalendarAdministrationError";
  }
}

export interface FeishuCalendarAdministrationServiceOptions {
  readonly backend: FeishuCalendarBackend;
  readonly store: FeishuCalendarStore;
  readonly clock?: () => string;
  readonly lease_seconds?: number;
}

function nonEmpty(value: string, field: string, maximum = 512): string {
  if (
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value
  ) {
    throw new FeishuCalendarAdministrationError(
      "invalid_administration_input",
      `${field} is invalid`,
    );
  }
  return value;
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${
    createHash("sha256").update(JSON.stringify(value)).digest("hex")
  }`;
}

export class FeishuCalendarAdministrationService
  implements FeishuCalendarAdministrationPort {
  private readonly resources = new FeishuCalendarResourceAdapter();
  private readonly clock: () => string;
  private readonly leaseSeconds: number;

  constructor(
    private readonly options: FeishuCalendarAdministrationServiceOptions,
  ) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.leaseSeconds = options.lease_seconds ?? 60;
    if (
      !Number.isSafeInteger(this.leaseSeconds) ||
      this.leaseSeconds < 5 ||
      this.leaseSeconds > 3_600
    ) throw new RangeError("Calendar administration lease is invalid");
  }

  async bindExisting(
    input: Parameters<FeishuCalendarAdministrationPort["bindExisting"]>[0],
  ): Promise<CalendarBinding> {
    this.validateIdentity(input);
    const replay = await this.existing(
      input.tenant_id,
      input.alias,
      input.external_calendar_id,
      input.make_default,
    );
    if (replay !== null) return replay;
    const facts = await this.options.backend.getCalendar({
      calendar_id: input.external_calendar_id,
    });
    return this.bindFacts({
      ...input,
      facts,
    });
  }

  async createAndBind(
    input: Parameters<FeishuCalendarAdministrationPort["createAndBind"]>[0],
  ): Promise<CalendarBinding> {
    this.validateIdentity(input);
    nonEmpty(input.summary, "summary");
    const existing = await this.options.store.getBinding(
      input.tenant_id,
      input.alias,
    );
    if (existing !== null) {
      return this.ensureDefault(existing, input.make_default);
    }

    const operationKey = `calendar-admin:create:${input.alias}`;
    let execution;
    try {
      execution = await this.options.store.beginExecution({
        tenant_id: input.tenant_id,
        idempotency_key: operationKey,
        capability_id: "feishu.calendar.admin.create-and-bind",
        input_digest: digest(input),
        created_at: this.clock(),
      });
    } catch {
      throw new FeishuCalendarAdministrationError(
        "calendar_administration_conflict",
        "Calendar alias has a different administrative operation",
      );
    }
    if (
      execution.record.outcome?.outcome === "failed" &&
      execution.record.outcome.code === "external_outcome_unknown"
    ) {
      throw this.unknownCreate();
    }
    if (execution.record.state === "completed") {
      const replay = await this.options.store.getBinding(
        input.tenant_id,
        input.alias,
      );
      if (replay === null) {
        throw new FeishuCalendarAdministrationError(
          "calendar_administration_inconsistent",
          "Completed calendar administration has no binding",
        );
      }
      return replay;
    }

    const now = this.clock();
    const leaseUntil = new Date(
      Date.parse(now) + this.leaseSeconds * 1_000,
    ).toISOString();
    if (
      execution.record.outcome?.outcome === "failed" &&
      execution.record.outcome.code === "calendar_administration_lease" &&
      execution.record.outcome.retry_after !== undefined &&
      Date.parse(execution.record.outcome.retry_after) > Date.parse(now)
    ) {
      throw new FeishuCalendarAdministrationError(
        "calendar_administration_in_progress",
        "Calendar administration is already in progress",
      );
    }
    try {
      execution = {
        created: execution.created,
        record: await this.options.store.checkpoint({
          tenant_id: input.tenant_id,
          idempotency_key: operationKey,
          expected_version: execution.record.version,
          state: "started",
          outcome: {
            outcome: "failed",
            code: "calendar_administration_lease",
            message: "Calendar administration lease is active",
            retryable: true,
            retry_after: leaseUntil,
          },
          updated_at: now,
        }),
      };
    } catch {
      throw new FeishuCalendarAdministrationError(
        "calendar_administration_in_progress",
        "Calendar administration is already in progress",
      );
    }

    let facts: FeishuCalendarFacts;
    try {
      facts = await this.options.backend.createSharedCalendar({
        summary: input.summary,
        ...(input.description === undefined
          ? {}
          : { description: input.description }),
        permissions: input.permissions,
      });
    } catch (error) {
      const unknown = error instanceof FeishuProviderBackendError &&
        error.code === "external_outcome_unknown";
      await this.options.store.checkpoint({
        tenant_id: input.tenant_id,
        idempotency_key: operationKey,
        expected_version: execution.record.version,
        state: "started",
        outcome: {
          outcome: "failed",
          code: unknown
            ? "external_outcome_unknown"
            : error instanceof FeishuProviderBackendError
            ? error.code
            : "feishu_temporarily_unavailable",
          message: unknown
            ? "Calendar creation outcome is unknown"
            : "Calendar creation failed",
          retryable: !unknown,
        },
        updated_at: this.clock(),
      });
      if (unknown) throw this.unknownCreate();
      throw error;
    }
    const binding = await this.bindFacts({
      tenant_id: input.tenant_id,
      alias: input.alias,
      external_calendar_id: facts.calendar_id,
      make_default: input.make_default,
      operator_principal_id: input.operator_principal_id,
      facts,
    });
    await this.options.store.checkpoint({
      tenant_id: input.tenant_id,
      idempotency_key: operationKey,
      expected_version: execution.record.version,
      state: "completed",
      outcome: {
        outcome: "succeeded",
        data: {
          alias: binding.alias,
          resource_uri: binding.resource_uri,
          version: binding.version,
        },
        artifacts: [],
      },
      updated_at: this.clock(),
    });
    return binding;
  }

  private validateIdentity(input: {
    readonly tenant_id: string;
    readonly alias: string;
    readonly operator_principal_id: string;
  }): void {
    nonEmpty(input.tenant_id, "tenant_id", 128);
    nonEmpty(input.alias, "alias", 128);
    nonEmpty(input.operator_principal_id, "operator_principal_id", 128);
  }

  private async existing(
    tenantId: string,
    alias: string,
    externalCalendarId: string,
    makeDefault: boolean,
  ): Promise<CalendarBinding | null> {
    const existing = await this.options.store.getBinding(tenantId, alias);
    if (existing === null) return null;
    if (existing.external_calendar_id !== externalCalendarId) {
      throw new FeishuCalendarAdministrationError(
        "calendar_alias_conflict",
        "Calendar alias is already bound to another resource",
      );
    }
    return this.ensureDefault(existing, makeDefault);
  }

  private async bindFacts(input: {
    readonly tenant_id: string;
    readonly alias: string;
    readonly external_calendar_id: string;
    readonly make_default: boolean;
    readonly operator_principal_id: string;
    readonly facts: FeishuCalendarFacts;
  }): Promise<CalendarBinding> {
    if (input.facts.calendar_id !== input.external_calendar_id) {
      throw new FeishuCalendarAdministrationError(
        "feishu_response_invalid",
        "Feishu returned another calendar",
      );
    }
    if (
      input.facts.calendar_type !== "primary" &&
      input.facts.calendar_type !== "shared"
    ) {
      throw new FeishuCalendarAdministrationError(
        "calendar_type_not_supported",
        "Calendar type is not supported",
      );
    }
    if (
      input.facts.access_role !== "writer" &&
      input.facts.access_role !== "owner"
    ) {
      throw new FeishuCalendarAdministrationError(
        "calendar_not_writable",
        "Calendar is not writable by the application",
      );
    }
    const now = this.clock();
    const created = await this.options.store.bind({
      tenant_id: input.tenant_id,
      alias: input.alias,
      resource_uri: this.resources.calendar(input.external_calendar_id),
      external_calendar_id: input.external_calendar_id,
      calendar_type: input.facts.calendar_type,
      access_role: input.facts.access_role,
      is_default: false,
      active: true,
      bound_by_principal_id: input.operator_principal_id,
      created_at: now,
      updated_at: now,
    }, 0);
    return this.ensureDefault(created, input.make_default);
  }

  private async ensureDefault(
    binding: CalendarBinding,
    makeDefault: boolean,
  ): Promise<CalendarBinding> {
    if (!makeDefault || binding.is_default) return binding;
    return this.options.store.setDefault({
      tenant_id: binding.tenant_id,
      alias: binding.alias,
      expected_version: binding.version,
      updated_at: this.clock(),
    });
  }

  private unknownCreate(): FeishuCalendarAdministrationError {
    return new FeishuCalendarAdministrationError(
      "external_outcome_unknown",
      "Calendar creation may have succeeded; list Feishu calendars and use bind-existing to reconcile",
    );
  }
}
