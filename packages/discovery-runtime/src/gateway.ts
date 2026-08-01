import type { JsonValue } from "@work-fabric/exchange-spi";
import {
  DISCOVERY_MAX_MESSAGE_BYTES,
  isDiscoveryTombstone,
  type DiscoveryClock,
  type DiscoveryExportPolicy,
  type DiscoveryIdGenerator,
  type DiscoveryPeerBinding,
  type DiscoveryPeerBindingStore,
  type DiscoveryPeerTransport,
  type DiscoveryStore,
  type DiscoveryStoredValue,
  type DiscoverySyncRequest,
  type DiscoverySyncResponse,
} from "@work-fabric/discovery-spi";

import { discoveryCanonicalJsonBytes } from "./canonical-json.js";
import type { DiscoveryCacheService } from "./cache-service.js";
import { DiscoveryError } from "./errors.js";
import {
  discoveryMessageDigest,
  type DiscoveryMessageCodec,
} from "./message-codec.js";
import type { DiscoveryRecordCodec } from "./record-codec.js";

export interface PreparedDiscoveryRequest {
  readonly peer_id: string;
  readonly target_exchange_id: string;
  readonly message_id: string;
  readonly request_digest: string;
  readonly bytes: Uint8Array;
}

export type DiscoverySyncResult =
  | { readonly outcome: "retryable_failure" }
  | {
      readonly outcome: "applied";
      readonly applied: number;
      readonly complete: boolean;
      readonly etag: string;
      readonly next_cursor?: string;
    };

export interface DiscoveryGatewayOptions {
  readonly tenant_id: string;
  readonly tenant_view_id: string;
  readonly local_exchange_id: string;
  readonly message_codec: DiscoveryMessageCodec;
  readonly record_codec: DiscoveryRecordCodec;
  readonly cache: DiscoveryCacheService;
  readonly store: DiscoveryStore;
  readonly peers: DiscoveryPeerBindingStore;
  readonly export_policy: DiscoveryExportPolicy;
  readonly clock: DiscoveryClock;
  readonly id_generator: DiscoveryIdGenerator;
  readonly message_ttl_seconds?: number;
  readonly tombstone_retention_seconds?: number;
}

interface ReplayEntry {
  readonly request_digest: string;
  readonly response: Uint8Array;
  readonly expires_at: number;
}

function identifier(value: string, label: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || value.trim() !== value) {
    throw new TypeError(`${label} is invalid`);
  }
}

function timestamp(value: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result) || !value.endsWith("Z") || new Date(result).toISOString() !== value) {
    throw new DiscoveryError("discovery_record_invalid");
  }
  return result;
}

function addSeconds(value: string, seconds: number): string {
  return new Date(timestamp(value) + seconds * 1_000).toISOString();
}

function decodeStoredValue(bytes: Uint8Array): DiscoveryStoredValue {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as DiscoveryStoredValue;
}

export class DiscoveryGateway {
  private readonly replay = new Map<string, ReplayEntry>();
  private readonly messageTtlSeconds: number;
  private readonly tombstoneRetentionSeconds: number;

  constructor(private readonly options: DiscoveryGatewayOptions) {
    identifier(options.tenant_id, "tenant_id");
    identifier(options.tenant_view_id, "tenant_view_id");
    identifier(options.local_exchange_id, "local_exchange_id");
    this.messageTtlSeconds = options.message_ttl_seconds ?? 20;
    this.tombstoneRetentionSeconds = options.tombstone_retention_seconds ?? 330;
    if (!Number.isSafeInteger(this.messageTtlSeconds) || this.messageTtlSeconds < 1 || this.messageTtlSeconds > 60) {
      throw new RangeError("message_ttl_seconds is invalid");
    }
    if (!Number.isSafeInteger(this.tombstoneRetentionSeconds) || this.tombstoneRetentionSeconds < 301 || this.tombstoneRetentionSeconds > 360) {
      throw new RangeError("tombstone_retention_seconds is invalid");
    }
    timestamp(options.clock.now());
  }

  async prepareSync(input: {
    readonly peer_id: string;
    readonly cursor?: string;
    readonly etag?: string;
  }): Promise<PreparedDiscoveryRequest> {
    identifier(input.peer_id, "peer_id");
    const peer = await this.requirePeer(input.peer_id, "import");
    const issuedAt = this.options.clock.now();
    const messageId = this.options.id_generator.nextId("message");
    identifier(messageId, "message_id");
    const payload: DiscoverySyncRequest = {
      limit: peer.max_page_size,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.etag === undefined ? {} : { etag: input.etag }),
    };
    const bytes = await this.options.message_codec.sign({
      message_id: messageId,
      message_type: "sync_request",
      target_exchange_id: peer.exchange_id,
      issued_at: issuedAt,
      expires_at: addSeconds(issuedAt, this.messageTtlSeconds),
      payload,
    });
    return {
      peer_id: peer.peer_id,
      target_exchange_id: peer.exchange_id,
      message_id: messageId,
      request_digest: discoveryMessageDigest(bytes),
      bytes,
    };
  }

  async receiveSync(requestBytes: Uint8Array): Promise<Uint8Array> {
    const request = await this.options.message_codec.verify(requestBytes);
    if (request.message_type !== "sync_request") throw new DiscoveryError("discovery_record_invalid");
    const peer = await this.requireSourcePeer(request.source_exchange_id, "export");
    const digest = discoveryMessageDigest(requestBytes);
    this.pruneReplay();
    const replay = this.replay.get(request.message_id);
    if (replay !== undefined) {
      if (replay.request_digest !== digest) throw new DiscoveryError("discovery_record_conflict");
      return replay.response.slice();
    }
    const payload = request.payload as DiscoverySyncRequest;
    const response = await this.buildSyncResponse(peer, request.message_id, digest, payload);
    this.replay.set(request.message_id, {
      request_digest: digest,
      response: response.slice(),
      expires_at: timestamp(request.expires_at),
    });
    return response;
  }

  async deliverSync(
    prepared: PreparedDiscoveryRequest,
    transport: DiscoveryPeerTransport,
  ): Promise<DiscoverySyncResult> {
    const peer = await this.requirePeer(prepared.peer_id, "import");
    if (peer.exchange_id !== prepared.target_exchange_id || discoveryMessageDigest(prepared.bytes) !== prepared.request_digest) {
      throw new DiscoveryError("discovery_record_invalid");
    }
    const responseBytes = await transport.exchange(prepared.bytes.slice());
    if (responseBytes === "retryable_failure") return { outcome: "retryable_failure" };
    if (responseBytes.byteLength > peer.max_response_bytes) throw new DiscoveryError("discovery_record_too_large");
    const response = await this.options.message_codec.verify(responseBytes);
    if (response.message_type !== "sync_response" || response.source_exchange_id !== peer.exchange_id) {
      throw new DiscoveryError("discovery_wrong_audience");
    }
    const payload = response.payload as DiscoverySyncResponse;
    if (payload.request_message_id !== prepared.message_id || payload.request_digest !== prepared.request_digest) {
      throw new DiscoveryError("discovery_record_conflict");
    }
    let applied = 0;
    for (const value of payload.items) {
      const result = await this.options.cache.accept({
        tenant_id: this.options.tenant_id,
        tenant_view_id: this.options.tenant_view_id,
        source_peer_id: peer.peer_id,
        audience_exchange_id: this.options.local_exchange_id,
        bytes: discoveryCanonicalJsonBytes(value as unknown as JsonValue),
      });
      if (result.outcome === "applied") applied += 1;
    }
    return {
      outcome: "applied",
      applied,
      complete: payload.complete,
      etag: payload.etag,
      ...(payload.next_cursor === undefined ? {} : { next_cursor: payload.next_cursor }),
    };
  }

  private async buildSyncResponse(
    peer: DiscoveryPeerBinding,
    requestMessageId: string,
    requestDigest: string,
    request: DiscoverySyncRequest,
  ): Promise<Uint8Array> {
    const issuedAt = this.options.clock.now();
    const responseMessageId = this.options.id_generator.nextId("message");
    let cursor = request.cursor;
    let etag = request.etag ?? 'W/"0"';
    let complete = false;
    const items: DiscoveryStoredValue[] = [];
    const maximum = Math.min(request.limit, peer.max_page_size);

    while (items.length < maximum) {
      const page = await this.options.store.changes({
        tenant_id: this.options.tenant_id,
        tenant_view_id: this.options.tenant_view_id,
        peer_id: peer.peer_id,
        ...(cursor === undefined ? {} : { cursor }),
        limit: 1,
      });
      etag = page.etag;
      if (items.length === 0 && request.cursor === undefined && request.etag === page.etag) {
        complete = true;
        break;
      }
      const stored = page.items[0];
      if (stored === undefined) {
        complete = true;
        break;
      }
      const exported = await this.exportValue(peer, stored);
      const nextCursor = page.next_cursor;
      if (nextCursor === undefined) throw new DiscoveryError("discovery_unavailable");
      const trialItems = [...items, exported];
      const trial = await this.signSyncResponse({
        responseMessageId,
        targetExchangeId: peer.exchange_id,
        issuedAt,
        requestMessageId,
        requestDigest,
        items: trialItems,
        nextCursor,
        etag,
        complete: false,
      });
      if (trial.byteLength > peer.max_response_bytes) {
        if (items.length === 0) throw new DiscoveryError("discovery_record_too_large");
        break;
      }
      items.push(exported);
      cursor = nextCursor;
    }

    return this.signSyncResponse({
      responseMessageId,
      targetExchangeId: peer.exchange_id,
      issuedAt,
      requestMessageId,
      requestDigest,
      items,
      ...(cursor === undefined ? {} : { nextCursor: cursor }),
      etag,
      complete,
    });
  }

  private async signSyncResponse(input: {
    readonly responseMessageId: string;
    readonly targetExchangeId: string;
    readonly issuedAt: string;
    readonly requestMessageId: string;
    readonly requestDigest: string;
    readonly items: readonly DiscoveryStoredValue[];
    readonly nextCursor?: string;
    readonly etag: string;
    readonly complete: boolean;
  }): Promise<Uint8Array> {
    return this.options.message_codec.sign({
      message_id: input.responseMessageId,
      message_type: "sync_response",
      target_exchange_id: input.targetExchangeId,
      issued_at: input.issuedAt,
      expires_at: addSeconds(input.issuedAt, this.messageTtlSeconds),
      payload: {
        request_message_id: input.requestMessageId,
        request_digest: input.requestDigest,
        items: input.items,
        etag: input.etag,
        complete: input.complete,
        ...(input.nextCursor === undefined ? {} : { next_cursor: input.nextCursor }),
      },
    });
  }

  private async exportValue(peer: DiscoveryPeerBinding, value: DiscoveryStoredValue): Promise<DiscoveryStoredValue> {
    if (isDiscoveryTombstone(value)) return value;
    const exported = await this.options.export_policy.exportRecord({
      scope: { tenant_id: this.options.tenant_id, tenant_view_id: this.options.tenant_view_id },
      peer,
      record: value,
    });
    if (exported !== null) return exported;
    const withdrawnAt = this.options.clock.now();
    const bytes = await this.options.record_codec.signTombstone({
      record_id: value.record_id,
      origin_exchange_id: this.options.local_exchange_id,
      revision: value.revision + 1,
      withdrawn_at: withdrawnAt,
      retain_until: addSeconds(withdrawnAt, this.tombstoneRetentionSeconds),
    });
    return decodeStoredValue(bytes);
  }

  private async requirePeer(peerId: string, direction: "import" | "export"): Promise<DiscoveryPeerBinding> {
    const peer = await this.options.peers.get({
      tenant_id: this.options.tenant_id,
      tenant_view_id: this.options.tenant_view_id,
    }, peerId);
    const allowed = direction === "import" ? peer?.allow_import : peer?.allow_export;
    if (peer === null || peer.state !== "active" || !allowed) throw new DiscoveryError("discovery_wrong_audience");
    return peer;
  }

  private async requireSourcePeer(exchangeId: string, direction: "import" | "export"): Promise<DiscoveryPeerBinding> {
    const matches = (await this.options.peers.list({
      tenant_id: this.options.tenant_id,
      tenant_view_id: this.options.tenant_view_id,
    })).filter((peer) => peer.exchange_id === exchangeId);
    if (matches.length !== 1) throw new DiscoveryError("discovery_wrong_audience");
    return this.requirePeer(matches[0]!.peer_id, direction);
  }

  private pruneReplay(): void {
    const now = timestamp(this.options.clock.now());
    for (const [messageId, entry] of this.replay) {
      if (entry.expires_at < now) this.replay.delete(messageId);
    }
  }
}
