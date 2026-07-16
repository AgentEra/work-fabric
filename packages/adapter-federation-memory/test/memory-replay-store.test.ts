import { describe, expect, it } from "vitest";

import { MemoryFederationReplayStore } from "../src/index.js";

const input = {
  source_exchange_id: "exchange-a",
  message_id: "message-1",
  request_digest: "a".repeat(64),
  expires_at: "2026-07-16T00:05:00.000Z",
} as const;

describe("MemoryFederationReplayStore", () => {
  it("distinguishes new, pending, completed and conflicting replay", async () => {
    const store = new MemoryFederationReplayStore({
      max_records: 10,
      clock: { now: () => "2026-07-16T00:00:00.000Z" },
    });
    await expect(store.begin(input)).resolves.toEqual({ kind: "new" });
    await expect(store.begin(input)).resolves.toEqual({ kind: "pending" });
    await expect(store.begin({ ...input, request_digest: "b".repeat(64) }))
      .resolves.toEqual({ kind: "conflict" });
    await store.complete({
      ...input,
      response: new Uint8Array([1, 2, 3]),
    });
    const completed = await store.begin(input);
    expect(completed).toEqual({
      kind: "completed",
      response: new Uint8Array([1, 2, 3]),
    });
    if (completed.kind === "completed") completed.response[0] = 9;
    await expect(store.begin(input)).resolves.toEqual({
      kind: "completed",
      response: new Uint8Array([1, 2, 3]),
    });
  });

  it("expires records and enforces a bounded capacity", async () => {
    let current = "2026-07-16T00:00:00.000Z";
    const store = new MemoryFederationReplayStore({
      max_records: 1,
      clock: { now: () => current },
    });
    await store.begin(input);
    await expect(store.begin({
      ...input,
      message_id: "message-2",
    })).rejects.toThrow(/capacity/);
    current = "2026-07-16T00:05:01.000Z";
    await expect(store.begin({
      ...input,
      message_id: "message-2",
      expires_at: "2026-07-16T00:10:00.000Z",
    })).resolves.toEqual({ kind: "new" });
  });
});
