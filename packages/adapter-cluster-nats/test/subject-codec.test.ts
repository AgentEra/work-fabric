import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { PartitionWakeup } from "@work-fabric/cluster-spi";
import { HmacWakeupSubjectCodec } from "../src/subject-codec.js";

const key = new TextEncoder().encode("subject-key-0123456789abcdef0123456789abcdef");
const wakeup: PartitionWakeup = {
  wakeup_id: "wakeup-subject",
  exchange_id: "exchange-subject",
  tenant_id: "tenant-a",
  partition_id: "partition-subject",
  kind: "signal_delivery",
  observed_position: 1,
  occurred_at: "2026-07-16T00:00:00.000Z",
};

function codec(tenants: readonly string[] = ["tenant-b", "tenant-a"]) {
  return new HmacWakeupSubjectCodec({
    subject_prefix: "workfabric.cluster.wakeup.v1",
    subject_key_id: "key1",
    subject_key: key,
    allowed_tenant_ids: tenants,
  });
}

describe("HmacWakeupSubjectCodec", () => {
  it("builds deterministic opaque tenant subjects", () => {
    const token = createHmac("sha256", key).update("tenant-a").digest("base64url");
    const subject = codec().subjectFor(wakeup);
    expect(subject).toBe(
      `workfabric.cluster.wakeup.v1.key1.${token}.signal_delivery`,
    );
    expect(subject).not.toContain("tenant-a");
  });

  it("returns sorted exact Tenant by work-kind filters", () => {
    const filters = codec().filterSubjects();
    expect(filters).toHaveLength(8);
    expect(filters).toEqual([...filters].sort());
    expect(new Set(filters).size).toBe(filters.length);
  });

  it("rejects unassigned tenants and body-subject mismatches", () => {
    expect(() => codec(["tenant-b"]).subjectFor(wakeup))
      .toThrow(/invalid_wakeup_subject/);
    expect(() => codec().assertMatches(
      codec().subjectFor(wakeup),
      { ...wakeup, tenant_id: "tenant-b" },
    )).toThrow(/invalid_wakeup_subject/);
  });

  it("rejects unsafe tokens, weak keys and unbounded Tenant sets", () => {
    expect(() => new HmacWakeupSubjectCodec({
      subject_prefix: "workfabric.>",
      subject_key_id: "key1",
      subject_key: key,
      allowed_tenant_ids: ["tenant-a"],
    })).toThrow(/invalid_wakeup_subject/);
    expect(() => new HmacWakeupSubjectCodec({
      subject_prefix: "workfabric.cluster.wakeup.v1",
      subject_key_id: "key1",
      subject_key: new Uint8Array(31),
      allowed_tenant_ids: ["tenant-a"],
    })).toThrow(/invalid_wakeup_subject/);
    expect(() => codec(Array.from({ length: 251 }, (_, i) => `tenant-${i}`)))
      .toThrow(/invalid_wakeup_subject/);
  });
});
