import {
  type CapabilityDescriptor,
  type EndpointDescriptor,
  type EndpointDirectoryStore,
} from "@work-fabric/exchange-spi";
import {
  isDiscoveryTombstone,
  type CapabilityRouteDiscoveryPayload,
  type DiscoveryClock,
  type DiscoveryRecord,
  type DiscoveryStore,
  type DiscoveryTombstone,
} from "@work-fabric/discovery-spi";

import { discoveryCanonicalSha256 } from "./canonical-json.js";
import type { DiscoveryRecordCodec } from "./record-codec.js";

interface CapabilityGroup {
  readonly versions: Set<string>;
  readonly inputMedia: Set<string>;
  readonly outputMedia: Set<string>;
  readonly inputSchemas: Set<string>;
  readonly outputSchemas: Set<string>;
  readonly modes: Set<"synchronous" | "asynchronous" | "status_updates">;
  readonly bindingTypes: Set<string>;
  readonly securitySchemes: Set<string>;
  availability: "available" | "constrained";
}

function addCapability(group: CapabilityGroup, capability: CapabilityDescriptor): void {
  group.versions.add(capability.version);
  capability.input_media_types.forEach((value) => group.inputMedia.add(value));
  capability.output_media_types.forEach((value) => group.outputMedia.add(value));
  capability.input_schema_refs.forEach((value) => group.inputSchemas.add(value));
  capability.output_schema_refs.forEach((value) => group.outputSchemas.add(value));
  capability.interaction_modes.forEach((value) => group.modes.add(value));
}

function sorted(values: ReadonlySet<string>): readonly string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function addSeconds(value: string, seconds: number): string {
  return new Date(Date.parse(value) + seconds * 1_000).toISOString();
}

function recordFromBytes(bytes: Uint8Array): DiscoveryRecord {
  return JSON.parse(new TextDecoder().decode(bytes)) as DiscoveryRecord;
}

function tombstoneFromBytes(bytes: Uint8Array): DiscoveryTombstone {
  return JSON.parse(new TextDecoder().decode(bytes)) as DiscoveryTombstone;
}

export interface EndpointDiscoveryExporterOptions {
  readonly local_exchange_id: string;
  readonly directory: EndpointDirectoryStore;
  readonly store: DiscoveryStore;
  readonly codec: DiscoveryRecordCodec;
  readonly clock: DiscoveryClock;
  readonly audiences: readonly string[];
  readonly safe_binding_types: readonly string[];
  readonly record_ttl_seconds: number;
  readonly renew_ahead_seconds: number;
  readonly page_size: number;
  readonly max_endpoints: number;
}

export class EndpointDiscoveryExporter {
  private readonly safeBindingTypes: ReadonlySet<string>;

  constructor(private readonly options: EndpointDiscoveryExporterOptions) {
    this.safeBindingTypes = new Set(options.safe_binding_types);
    if (options.record_ttl_seconds < 1 || options.record_ttl_seconds > 300) throw new RangeError("record_ttl_seconds is invalid");
    if (options.renew_ahead_seconds < 0 || options.renew_ahead_seconds >= options.record_ttl_seconds) throw new RangeError("renew_ahead_seconds is invalid");
    if (options.page_size < 1 || options.max_endpoints < options.page_size) throw new RangeError("Endpoint export bounds are invalid");
  }

  async refresh(tenantId: string, tenantViewId: string): Promise<{
    readonly changed: number;
    readonly unchanged: number;
    readonly withdrawn: number;
  }> {
    const now = this.options.clock.now();
    const endpoints = await this.readEndpoints(tenantId, now);
    const payloads = this.aggregate(endpoints);
    const scope = { tenant_id: tenantId, tenant_view_id: tenantViewId };
    const currentPage = await this.options.store.query({
      ...scope,
      now,
      limit: Math.max(1, this.options.max_endpoints),
      record_kinds: ["capability_route"],
      origin_exchange_id: this.options.local_exchange_id,
    });
    const current = new Map(currentPage.items.map((record) => [record.record_id, record]));
    let changed = 0;
    let unchanged = 0;
    for (const [recordId, payload] of payloads) {
      const previous = current.get(recordId);
      current.delete(recordId);
      const samePublicValue = previous?.record_kind === "capability_route" &&
        previous.payload_digest === discoveryCanonicalSha256(payload as never) &&
        JSON.stringify(previous.audiences) === JSON.stringify([...this.options.audiences].sort()) &&
        previous.visibility === "peer" && !previous.transitive;
      if (samePublicValue && Date.parse(previous.expires_at) > Date.parse(addSeconds(now, this.options.renew_ahead_seconds))) {
        unchanged += 1;
        continue;
      }
      const bytes = await this.options.codec.sign({
        record_id: recordId,
        record_kind: "capability_route",
        origin_exchange_id: this.options.local_exchange_id,
        revision: (previous?.revision ?? 0) + 1,
        issued_at: now,
        expires_at: addSeconds(now, this.options.record_ttl_seconds),
        visibility: "peer",
        audiences: [...this.options.audiences].sort(),
        transitive: false,
        max_hops: 0,
        payload,
      });
      await this.options.store.apply({ ...scope, source_peer_id: null, value: recordFromBytes(bytes) });
      changed += 1;
    }
    let withdrawn = 0;
    for (const previous of current.values()) {
      const bytes = await this.options.codec.signTombstone({
        record_id: previous.record_id,
        origin_exchange_id: this.options.local_exchange_id,
        revision: previous.revision + 1,
        withdrawn_at: now,
        retain_until: addSeconds(now, Math.min(360, this.options.record_ttl_seconds + 60)),
      });
      const tombstone = tombstoneFromBytes(bytes);
      if (!isDiscoveryTombstone(tombstone)) throw new Error("discovery tombstone encoding failed");
      await this.options.store.apply({ ...scope, source_peer_id: null, value: tombstone });
      withdrawn += 1;
    }
    return { changed, unchanged, withdrawn };
  }

  private async readEndpoints(tenantId: string, now: string): Promise<readonly EndpointDescriptor[]> {
    const result: EndpointDescriptor[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.options.directory.discover({
        tenant_id: tenantId,
        now,
        limit: this.options.page_size,
        ...(cursor === undefined ? {} : { cursor }),
      });
      result.push(...page.items);
      if (result.length > this.options.max_endpoints) throw new RangeError("Endpoint export bound exceeded");
      cursor = page.next_cursor;
    } while (cursor !== undefined);
    return result;
  }

  private aggregate(endpoints: readonly EndpointDescriptor[]): ReadonlyMap<string, CapabilityRouteDiscoveryPayload> {
    const groups = new Map<string, CapabilityGroup>();
    for (const endpoint of endpoints) {
      for (const capability of endpoint.capabilities) {
        let group = groups.get(capability.capability_id);
        if (group === undefined) {
          group = {
            versions: new Set(), inputMedia: new Set(), outputMedia: new Set(),
            inputSchemas: new Set(), outputSchemas: new Set(), modes: new Set(),
            bindingTypes: new Set(), securitySchemes: new Set(),
            availability: endpoint.availability === "available" ? "available" : "constrained",
          };
          groups.set(capability.capability_id, group);
        }
        if (endpoint.availability === "available") group.availability = "available";
        addCapability(group, capability);
        for (const binding of endpoint.bindings) {
          if (!this.safeBindingTypes.has(binding.binding_type)) continue;
          group.bindingTypes.add(binding.binding_type);
          binding.security_schemes.forEach((scheme) => group!.securitySchemes.add(scheme));
        }
      }
    }
    return new Map([...groups.entries()].map(([capabilityId, group]) => {
      const payload: CapabilityRouteDiscoveryPayload = {
        capability_id: capabilityId,
        versions: sorted(group.versions),
        input_media_types: sorted(group.inputMedia),
        output_media_types: sorted(group.outputMedia),
        input_schema_refs: sorted(group.inputSchemas),
        output_schema_refs: sorted(group.outputSchemas),
        interaction_modes: sorted(group.modes) as CapabilityRouteDiscoveryPayload["interaction_modes"],
        binding_types: sorted(group.bindingTypes),
        security_schemes: sorted(group.securitySchemes),
        availability: group.availability,
      };
      const recordId = `capability-route:${discoveryCanonicalSha256({ capability_id: capabilityId })}`;
      return [recordId, payload];
    }));
  }
}
