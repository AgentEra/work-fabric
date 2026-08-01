import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  DiscoveryCallContext,
  DiscoveryClock,
  DiscoveryDisclosurePolicy,
  DiscoveryPage,
  DiscoveryRecord,
  DiscoveryRecordKind,
  DiscoveryStore,
  DiscoveryStoreQuery,
} from "@work-fabric/discovery-spi";

import { DiscoveryError } from "./errors.js";

export interface DiscoveryFindCapabilitiesInput {
  readonly capability_id?: string;
  readonly version_constraint?: string;
  readonly input_media_types?: readonly string[];
  readonly output_media_types?: readonly string[];
  readonly interaction_modes?: readonly string[];
  readonly binding_types?: readonly string[];
  readonly cursor?: string;
  readonly limit?: number;
}

export interface DiscoveryQueryServiceOptions {
  readonly store: DiscoveryStore;
  readonly policy: DiscoveryDisclosurePolicy;
  readonly clock: DiscoveryClock;
  readonly cursor_secret: string | Uint8Array;
  readonly default_page_limit: number;
  readonly max_page_limit: number;
  readonly max_scan_results: number;
}

interface CursorPayload {
  readonly version: 1;
  readonly binding: string;
  readonly offset: number;
}

function validPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} is invalid`);
}

function validateIdentifier(value: string, label: string): void {
  if (value.length === 0 || value.length > 256) throw new TypeError(`${label} is invalid`);
}

function validateStringList(value: readonly string[] | undefined, label: string): void {
  if (value === undefined) return;
  if (value.length > 32 || value.some((item) => item.length === 0 || item.length > 256)) {
    throw new TypeError(`${label} is invalid`);
  }
}

function stableRecordOrder(left: DiscoveryRecord, right: DiscoveryRecord): number {
  return `${left.origin_exchange_id}\u0000${left.record_id}`.localeCompare(
    `${right.origin_exchange_id}\u0000${right.record_id}`,
  );
}

export class DiscoveryQueryService {
  private readonly secret: Uint8Array;

  constructor(private readonly options: DiscoveryQueryServiceOptions) {
    validPositiveInteger(options.default_page_limit, "default_page_limit");
    validPositiveInteger(options.max_page_limit, "max_page_limit");
    validPositiveInteger(options.max_scan_results, "max_scan_results");
    if (options.default_page_limit > options.max_page_limit) {
      throw new RangeError("default_page_limit exceeds max_page_limit");
    }
    this.secret = typeof options.cursor_secret === "string"
      ? new TextEncoder().encode(options.cursor_secret)
      : options.cursor_secret.slice();
    if (this.secret.byteLength < 32) throw new RangeError("cursor_secret is too short");
  }

  async findCapabilities(
    context: DiscoveryCallContext,
    input: DiscoveryFindCapabilitiesInput = {},
  ): Promise<DiscoveryPage> {
    this.validateContext(context);
    this.validateCapabilityInput(input);
    const limit = input.limit ?? this.options.default_page_limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.options.max_page_limit) {
      throw new RangeError("limit is invalid");
    }
    const binding = this.cursorBinding(context, input, limit);
    const offset = input.cursor === undefined ? 0 : this.decodeCursor(input.cursor, binding);
    const storeQuery: DiscoveryStoreQuery = {
      tenant_id: context.tenant_id,
      tenant_view_id: context.tenant_view_id,
      now: this.options.clock.now(),
      record_kinds: ["capability_route"],
      limit: this.options.max_scan_results,
      ...(input.capability_id === undefined ? {} : { capability_id: input.capability_id }),
      ...(input.version_constraint === undefined ? {} : { version_constraint: input.version_constraint }),
      ...(input.input_media_types === undefined ? {} : { input_media_types: input.input_media_types }),
      ...(input.output_media_types === undefined ? {} : { output_media_types: input.output_media_types }),
      ...(input.interaction_modes === undefined ? {} : { interaction_modes: input.interaction_modes }),
      ...(input.binding_types === undefined ? {} : { binding_types: input.binding_types }),
    };
    const stored = await this.options.store.query(storeQuery);
    const authorized = (await Promise.all(stored.items.map(async (record) =>
      await this.canRead(context, record) ? record : null
    )))
      .filter((record): record is DiscoveryRecord => record !== null)
      .sort(stableRecordOrder);
    if (offset > authorized.length) throw new DiscoveryError("discovery_cursor_invalid");
    const items = authorized.slice(offset, offset + limit);
    const hasAuthorizedMore = offset + items.length < authorized.length;
    const scanLimited = stored.next_cursor !== undefined;
    return {
      coverage: scanLimited || stored.coverage === "partial" ? "partial" : stored.coverage,
      items,
      warnings: scanLimited
        ? [...stored.warnings, "discovery_scan_limit_reached"]
        : stored.warnings,
      ...(hasAuthorizedMore ? { next_cursor: this.encodeCursor(binding, offset + items.length) } : {}),
    };
  }

  async filterFederated(
    context: DiscoveryCallContext,
    page: DiscoveryPage,
  ): Promise<DiscoveryPage> {
    this.validateContext(context);
    const now = Date.parse(this.options.clock.now());
    const items = (await Promise.all(page.items.map(async (record) =>
      Date.parse(record.expires_at) > now && await this.canRead(context, record) ? record : null
    )))
      .filter((record): record is DiscoveryRecord => record !== null)
      .sort(stableRecordOrder);
    return {
      coverage: page.coverage,
      items,
      warnings: [...page.warnings],
      ...(page.next_cursor === undefined ? {} : { next_cursor: page.next_cursor }),
    };
  }

  getExchange(context: DiscoveryCallContext, exchangeId: string): Promise<DiscoveryRecord<"exchange">> {
    return this.resolve(context, "exchange", "exchange_id", exchangeId);
  }

  getParticipant(context: DiscoveryCallContext, actorId: string): Promise<DiscoveryRecord<"participant">> {
    return this.resolve(context, "participant", "actor_id", actorId);
  }

  getEndpoint(context: DiscoveryCallContext, endpointId: string): Promise<DiscoveryRecord<"endpoint">> {
    return this.resolve(context, "endpoint", "endpoint_id", endpointId);
  }

  private async resolve<K extends Exclude<DiscoveryRecordKind, "capability_route">>(
    context: DiscoveryCallContext,
    kind: K,
    selector: "exchange_id" | "actor_id" | "endpoint_id",
    identifier: string,
  ): Promise<DiscoveryRecord<K>> {
    this.validateContext(context);
    validateIdentifier(identifier, selector);
    const page = await this.options.store.query({
      tenant_id: context.tenant_id,
      tenant_view_id: context.tenant_view_id,
      now: this.options.clock.now(),
      record_kinds: [kind],
      [selector]: identifier,
      limit: 1,
    });
    const record = page.items[0];
    if (record === undefined || record.record_kind !== kind || !(await this.canRead(context, record))) {
      throw new DiscoveryError("discovery_not_found");
    }
    return record as DiscoveryRecord<K>;
  }

  private async canRead(context: DiscoveryCallContext, record: DiscoveryRecord): Promise<boolean> {
    try {
      return await this.options.policy.canRead({ context, record });
    } catch {
      return false;
    }
  }

  private validateContext(context: DiscoveryCallContext): void {
    validateIdentifier(context.tenant_id, "tenant_id");
    validateIdentifier(context.tenant_view_id, "tenant_view_id");
    validateIdentifier(context.principal_id, "principal_id");
  }

  private validateCapabilityInput(input: DiscoveryFindCapabilitiesInput): void {
    if (input.capability_id !== undefined) validateIdentifier(input.capability_id, "capability_id");
    if (input.version_constraint !== undefined && input.version_constraint.length > 256) {
      throw new TypeError("version_constraint is invalid");
    }
    validateStringList(input.input_media_types, "input_media_types");
    validateStringList(input.output_media_types, "output_media_types");
    validateStringList(input.interaction_modes, "interaction_modes");
    validateStringList(input.binding_types, "binding_types");
  }

  private cursorBinding(
    context: DiscoveryCallContext,
    input: DiscoveryFindCapabilitiesInput,
    limit: number,
  ): string {
    const { cursor: _cursor, limit: _inputLimit, ...filters } = input;
    return createHmac("sha256", this.secret).update(JSON.stringify({
      tenant_id: context.tenant_id,
      tenant_view_id: context.tenant_view_id,
      principal_id: context.principal_id,
      represented_actor: context.represented_actor ?? null,
      represented_endpoint_id: context.represented_endpoint_id ?? null,
      filters,
      limit,
    })).digest("base64url");
  }

  private encodeCursor(binding: string, offset: number): string {
    const body = Buffer.from(JSON.stringify({ version: 1, binding, offset } satisfies CursorPayload))
      .toString("base64url");
    const signature = createHmac("sha256", this.secret).update(body).digest("base64url");
    return `${body}.${signature}`;
  }

  private decodeCursor(cursor: string, binding: string): number {
    try {
      const [body, suppliedSignature, extra] = cursor.split(".");
      if (body === undefined || suppliedSignature === undefined || extra !== undefined) throw new Error();
      const expectedSignature = createHmac("sha256", this.secret).update(body).digest();
      const supplied = Buffer.from(suppliedSignature, "base64url");
      if (supplied.length !== expectedSignature.length || !timingSafeEqual(supplied, expectedSignature)) throw new Error();
      const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<CursorPayload>;
      if (payload.version !== 1 || payload.binding !== binding || !Number.isSafeInteger(payload.offset) || payload.offset! < 0) {
        throw new Error();
      }
      return payload.offset!;
    } catch {
      throw new DiscoveryError("discovery_cursor_invalid");
    }
  }
}
