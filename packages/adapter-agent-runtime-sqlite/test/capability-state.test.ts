import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyCapabilityInvocationStoreContract } from "@work-fabric/agent-runtime-conformance";
import { describe, expect, it } from "vitest";

import { SqliteAgentRuntimeStateStore } from "../src/index.js";

verifyCapabilityInvocationStoreContract(
  "SQLite Agent capability invocation state",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "work-fabric-agent-capability-"));
    const store = new SqliteAgentRuntimeStateStore({
      location: join(directory, "runtime.db"),
    });
    return {
      store,
      async close() {
        await store.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  },
);

describe("SQLite Agent capability invocation durability", () => {
  it("restores a pending invocation after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "work-fabric-agent-capability-restart-"));
    const location = join(directory, "runtime.db");
    try {
      const first = new SqliteAgentRuntimeStateStore({ location });
      await first.createInvocationIfAbsent({
        tenant_id: "tenant-1",
        request: {
          invocation_id: "invocation-1",
          original_handoff_id: "handoff-1",
          thread_id: "thread-1",
          capability_id: "feishu.document.create",
          version_constraint: "^1.0.0",
          input: { title: "Brief" },
          reason: "The user requested a document.",
          deadline: "2026-07-27T02:00:00.000Z",
        },
        request_digest: `sha256:${"a".repeat(64)}`,
        now: "2026-07-27T01:00:00.000Z",
      });
      await first.close();

      const second = new SqliteAgentRuntimeStateStore({ location });
      expect(await second.getInvocation(
        "tenant-1",
        "handoff-1",
        "invocation-1",
      )).toMatchObject({
        state: "requested",
        request: { capability_id: "feishu.document.create" },
      });
      await second.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
