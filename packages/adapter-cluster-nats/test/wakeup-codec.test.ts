import { describe, expect, it } from "vitest";

import type { PartitionWakeup } from "@work-fabric/cluster-spi";
import {
  NATS_WAKEUP_MAX_BYTES,
  NATS_WAKEUP_SCHEMA,
  decodeWakeup,
  encodeWakeup,
} from "../src/wakeup-codec.js";

const wakeup: PartitionWakeup = {
  wakeup_id: "wakeup-codec",
  exchange_id: "exchange-codec",
  tenant_id: "tenant-codec",
  partition_id: "partition-codec",
  kind: "handoff_projection",
  observed_position: 42,
  occurred_at: "2026-07-16T00:00:00.000Z",
};

function bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

describe("NATS Wakeup codec", () => {
  it("round-trips the exact canonical metadata shape", () => {
    const encoded = encodeWakeup(wakeup);
    expect(encoded.byteLength).toBeLessThanOrEqual(NATS_WAKEUP_MAX_BYTES);
    expect(JSON.parse(new TextDecoder().decode(encoded))).toEqual({
      schema: NATS_WAKEUP_SCHEMA,
      ...wakeup,
    });
    expect(decodeWakeup(encoded)).toEqual(wakeup);
  });

  it("rejects unknown, content-bearing and missing fields", () => {
    const canonical = { schema: NATS_WAKEUP_SCHEMA, ...wakeup };
    expect(() => decodeWakeup(bytes({ ...canonical, content: "forbidden" })))
      .toThrow(/invalid_wakeup_payload/);
    expect(() => decodeWakeup(bytes({ ...canonical, credential: "forbidden" })))
      .toThrow(/invalid_wakeup_payload/);
    const { occurred_at: _omitted, ...missing } = canonical;
    expect(() => decodeWakeup(bytes(missing))).toThrow(/invalid_wakeup_payload/);
  });

  it("rejects invalid semantic values and oversized bytes", () => {
    expect(() => decodeWakeup(bytes({
      schema: NATS_WAKEUP_SCHEMA,
      ...wakeup,
      observed_position: 0,
    }))).toThrow(/invalid_wakeup_payload/);
    expect(() => decodeWakeup(bytes({
      schema: NATS_WAKEUP_SCHEMA,
      ...wakeup,
      occurred_at: "not-a-time",
    }))).toThrow(/invalid_wakeup_payload/);
    expect(() => decodeWakeup(new Uint8Array(NATS_WAKEUP_MAX_BYTES + 1)))
      .toThrow(/invalid_wakeup_payload/);
  });

  it("does not retain caller-owned bytes", () => {
    const encoded = encodeWakeup(wakeup);
    const decoded = decodeWakeup(encoded);
    encoded.fill(0);
    expect(decoded).toEqual(wakeup);
  });
});
