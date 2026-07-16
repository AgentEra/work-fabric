import { createHmac, timingSafeEqual } from "node:crypto";

import {
  PARTITION_WORK_KINDS,
  clusterIdentifier,
  validatePartitionWakeup,
  type PartitionWakeup,
  type PartitionWorkKind,
} from "@work-fabric/cluster-spi";

import { NatsWakeupError } from "./errors.js";

const tokenPattern = /^[A-Za-z0-9_-]{1,64}$/;

function invalid(): never {
  throw new NatsWakeupError("invalid_wakeup_subject");
}

function literalToken(value: string): string {
  if (!tokenPattern.test(value)) return invalid();
  return value;
}

function prefix(value: string): readonly string[] {
  if (typeof value !== "string" || value.length === 0 || value.length > 320) {
    return invalid();
  }
  const tokens = value.split(".");
  if (tokens.length === 0) return invalid();
  return tokens.map(literalToken);
}

function equalToken(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export interface HmacWakeupSubjectCodecOptions {
  readonly subject_prefix: string;
  readonly subject_key_id: string;
  readonly subject_key: Uint8Array;
  readonly allowed_tenant_ids: readonly string[];
}

export class HmacWakeupSubjectCodec {
  private readonly prefixTokens: readonly string[];
  private readonly keyId: string;
  private readonly key: Uint8Array;
  private readonly tenants: readonly string[];
  private readonly tenantTokens = new Map<string, string>();

  constructor(options: HmacWakeupSubjectCodecOptions) {
    this.prefixTokens = prefix(options.subject_prefix);
    this.keyId = literalToken(options.subject_key_id);
    if (
      !(options.subject_key instanceof Uint8Array) ||
      options.subject_key.byteLength < 32 || options.subject_key.byteLength > 128
    ) invalid();
    this.key = Uint8Array.from(options.subject_key);
    if (
      !Array.isArray(options.allowed_tenant_ids) ||
      options.allowed_tenant_ids.length < 1 ||
      options.allowed_tenant_ids.length > 250
    ) invalid();
    try {
      this.tenants = [...new Set(options.allowed_tenant_ids.map(
        (tenantId) => clusterIdentifier(tenantId, "tenant_id"),
      ))].sort();
    } catch { invalid(); }
    for (const tenantId of this.tenants) {
      this.tenantTokens.set(tenantId, this.token(tenantId));
    }
  }

  subjectFor(candidate: PartitionWakeup): string {
    let wakeup: PartitionWakeup;
    try { wakeup = validatePartitionWakeup(candidate); } catch { return invalid(); }
    const tenantToken = this.tenantTokens.get(wakeup.tenant_id);
    if (tenantToken === undefined) return invalid();
    return [...this.prefixTokens, this.keyId, tenantToken, wakeup.kind].join(".");
  }

  filterSubjects(): readonly string[] {
    const filters: string[] = [];
    for (const tenantId of this.tenants) {
      const tenantToken = this.tenantTokens.get(tenantId);
      if (tenantToken === undefined) return invalid();
      for (const kind of PARTITION_WORK_KINDS) {
        filters.push([
          ...this.prefixTokens,
          this.keyId,
          tenantToken,
          literalToken(kind),
        ].join("."));
      }
    }
    return filters.sort();
  }

  assertMatches(subject: string, candidate: PartitionWakeup): void {
    if (typeof subject !== "string") return invalid();
    let wakeup: PartitionWakeup;
    try { wakeup = validatePartitionWakeup(candidate); } catch { return invalid(); }
    const expected = this.subjectFor(wakeup);
    if (!equalToken(subject, expected)) return invalid();
  }

  private token(tenantId: string): string {
    return createHmac("sha256", this.key).update(tenantId, "utf8").digest("base64url");
  }
}

export function natsWorkKindToken(kind: PartitionWorkKind): string {
  return literalToken(kind);
}
