import { createHash } from "node:crypto";

import type {
  AgentCapabilityInvocationStore,
  CapabilityInvocationRequest,
} from "@work-fabric/agent-runtime-spi";
import { describe, expect, it } from "vitest";

export interface CapabilityStateStoreFixture {
  readonly store: AgentCapabilityInvocationStore;
  close(): Promise<void>;
}

const NOW = "2026-07-27T01:00:00.000Z";
const request: CapabilityInvocationRequest = {
  invocation_id: "invocation-1",
  original_handoff_id: "handoff-1",
  thread_id: "thread-1",
  capability_id: "feishu.document.create",
  version_constraint: "^1.0.0",
  input: { title: "Brief" },
  reason: "The user requested a document.",
  deadline: "2026-07-27T02:00:00.000Z",
};
const requestDigest = `sha256:${createHash("sha256")
  .update(JSON.stringify(request))
  .digest("hex")}` as const;
const candidate = {
  citizen_id: "feishu-actions",
  endpoint_id: "endpoint-feishu-actions",
  capability_id: "feishu.document.create",
  capability_version: "1.0.0",
  contract_digest: `sha256:${"a".repeat(64)}` as const,
};

export function verifyCapabilityInvocationStoreContract(
  name: string,
  create: () => Promise<CapabilityStateStoreFixture>,
): void {
  describe(name, () => {
    it("deduplicates the immutable invocation request and rejects conflicts", async () => {
      const fixture = await create();
      try {
        const first = await fixture.store.createInvocationIfAbsent({
          tenant_id: "tenant-1",
          request,
          request_digest: requestDigest,
          now: NOW,
        });
        const replay = await fixture.store.createInvocationIfAbsent({
          tenant_id: "tenant-1",
          request,
          request_digest: requestDigest,
          now: "2026-07-27T01:00:01.000Z",
        });
        expect(first.created).toBe(true);
        expect(replay).toEqual({ created: false, record: first.record });
        await expect(fixture.store.createInvocationIfAbsent({
          tenant_id: "tenant-1",
          request: { ...request, reason: "Different request." },
          request_digest: `sha256:${"b".repeat(64)}`,
          now: NOW,
        })).rejects.toThrow(/idempotency/i);
      } finally {
        await fixture.close();
      }
    });

    it("fences an expired owner and rejects its later transition", async () => {
      const fixture = await create();
      try {
        await fixture.store.createInvocationIfAbsent({
          tenant_id: "tenant-1", request, request_digest: requestDigest, now: NOW,
        });
        const first = await fixture.store.claimInvocation({
          tenant_id: "tenant-1", original_handoff_id: "handoff-1",
          invocation_id: "invocation-1", owner: "host-a", now: NOW,
          lease_seconds: 2, allowed_states: ["requested"],
        });
        const second = await fixture.store.claimInvocation({
          tenant_id: "tenant-1", original_handoff_id: "handoff-1",
          invocation_id: "invocation-1", owner: "host-b",
          now: "2026-07-27T01:00:03.000Z", lease_seconds: 2,
          allowed_states: ["requested"],
        });
        expect(first?.fencing_token).toBe(1);
        expect(second?.fencing_token).toBe(2);
        expect(await fixture.store.transitionInvocation({
          tenant_id: "tenant-1", original_handoff_id: "handoff-1",
          invocation_id: "invocation-1", owner: "host-a", fencing_token: 1,
          expected_state: "requested", next_state: "offered",
          now: "2026-07-27T01:00:03.500Z", candidate,
          auxiliary_handoff_id: "handoff-capability-1",
        })).toBe(false);
      } finally {
        await fixture.close();
      }
    });

    it("requires a frozen candidate binding before waiting and a matching terminal result", async () => {
      const fixture = await create();
      try {
        await fixture.store.createInvocationIfAbsent({
          tenant_id: "tenant-1", request, request_digest: requestDigest, now: NOW,
        });
        await fixture.store.claimInvocation({
          tenant_id: "tenant-1", original_handoff_id: "handoff-1",
          invocation_id: "invocation-1", owner: "host-a", now: NOW,
          lease_seconds: 60, allowed_states: ["requested"],
        });
        expect(await fixture.store.transitionInvocation({
          tenant_id: "tenant-1", original_handoff_id: "handoff-1",
          invocation_id: "invocation-1", owner: "host-a", fencing_token: 1,
          expected_state: "requested", next_state: "offered",
          now: "2026-07-27T01:00:01.000Z",
        })).toBe(false);
        expect(await fixture.store.transitionInvocation({
          tenant_id: "tenant-1", original_handoff_id: "handoff-1",
          invocation_id: "invocation-1", owner: "host-a", fencing_token: 1,
          expected_state: "requested", next_state: "offered",
          now: "2026-07-27T01:00:01.000Z", candidate,
          auxiliary_handoff_id: "handoff-capability-1",
        })).toBe(true);
        expect(await fixture.store.transitionInvocation({
          tenant_id: "tenant-1", original_handoff_id: "handoff-1",
          invocation_id: "invocation-1", owner: "host-a", fencing_token: 1,
          expected_state: "offered", next_state: "waiting",
          now: "2026-07-27T01:00:02.000Z",
        })).toBe(true);
        expect(await fixture.store.transitionInvocation({
          tenant_id: "tenant-1", original_handoff_id: "handoff-1",
          invocation_id: "invocation-1", owner: "host-a", fencing_token: 1,
          expected_state: "waiting", next_state: "succeeded",
          now: "2026-07-27T01:00:03.000Z",
        })).toBe(false);
        const result = {
          outcome: "succeeded" as const,
          invocation_id: "invocation-1",
          auxiliary_handoff_id: "handoff-capability-1",
          candidate,
          data: { document_token: "docx-1" },
          artifacts: [],
        };
        expect(await fixture.store.transitionInvocation({
          tenant_id: "tenant-1", original_handoff_id: "handoff-1",
          invocation_id: "invocation-1", owner: "host-a", fencing_token: 1,
          expected_state: "waiting", next_state: "succeeded",
          now: "2026-07-27T01:00:03.000Z", result,
        })).toBe(true);
        expect(await fixture.store.listRecoverableInvocations(
          "tenant-1",
          "2026-07-27T03:00:00.000Z",
          10,
        )).toEqual([]);
      } finally {
        await fixture.close();
      }
    });

    it("isolates tenants and returns defensive copies", async () => {
      const fixture = await create();
      try {
        const first = await fixture.store.createInvocationIfAbsent({
          tenant_id: "tenant-1", request, request_digest: requestDigest, now: NOW,
        });
        await fixture.store.createInvocationIfAbsent({
          tenant_id: "tenant-2", request, request_digest: requestDigest, now: NOW,
        });
        (first.record.request.input as { title: string }).title = "changed";
        expect((await fixture.store.getInvocation(
          "tenant-1",
          "handoff-1",
          "invocation-1",
        ))?.request.input).toEqual({ title: "Brief" });
        expect(await fixture.store.listRecoverableInvocations(
          "tenant-1", NOW, 10,
        )).toHaveLength(1);
        expect(await fixture.store.listRecoverableInvocations(
          "tenant-2", NOW, 10,
        )).toHaveLength(1);
      } finally {
        await fixture.close();
      }
    });
  });
}
