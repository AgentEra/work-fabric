import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  ConfirmationService,
  MemoryConfirmationStore,
  SqliteConfirmationStore,
} from "../src/index.js";

const binding = {
  tenant_id: "tenant-a",
  human_actor_id: "human-1",
  capability_id: "feishu.document.delete",
  document_token: "doc-1",
  normalized_input_digest: `sha256:${"a".repeat(64)}` as const,
};

function service(store: MemoryConfirmationStore | SqliteConfirmationStore) {
  let sequence = 0;
  return new ConfirmationService({
    store,
    now: () => "2026-07-27T10:00:00.000Z",
    next_id: (kind) => `${kind}-${++sequence}`,
    challenge_ttl_seconds: 300,
  });
}

describe.each([
  ["memory", () => new MemoryConfirmationStore()],
  ["sqlite", () => new SqliteConfirmationStore(new DatabaseSync(":memory:"))],
])("ConfirmationService (%s)", (_name, createStore) => {
  it("binds an exact human confirmation and consumes the proof once", async () => {
    const confirmations = service(createStore());
    const challenge = await confirmations.issue(binding);

    expect(challenge.phrase).toBe(`确认删除 ${challenge.challenge_code}`);
    await expect(confirmations.confirm({
      tenant_id: binding.tenant_id,
      human_actor_id: "human-2",
      message_text: challenge.phrase,
    })).resolves.toBeNull();

    const proof = await confirmations.confirm({
      tenant_id: binding.tenant_id,
      human_actor_id: binding.human_actor_id,
      message_text: challenge.phrase,
    });
    expect(proof?.proof_reference).toBe("proof-2");

    await expect(confirmations.consume({
      ...binding,
      proof_reference: proof!.proof_reference,
    })).resolves.toBe(true);
    await expect(confirmations.consume({
      ...binding,
      proof_reference: proof!.proof_reference,
    })).resolves.toBe(false);
  });

  it("rejects mismatched and expired evidence", async () => {
    const store = createStore();
    let now = "2026-07-27T10:00:00.000Z";
    let sequence = 0;
    const confirmations = new ConfirmationService({
      store,
      now: () => now,
      next_id: (kind) => `${kind}-${++sequence}`,
      challenge_ttl_seconds: 1,
    });
    const challenge = await confirmations.issue(binding);
    now = "2026-07-27T10:00:02.000Z";
    await expect(confirmations.confirm({
      tenant_id: binding.tenant_id,
      human_actor_id: binding.human_actor_id,
      message_text: challenge.phrase,
    })).resolves.toBeNull();
  });
});
