import type {
  AgentPrivateStateStore,
  AgentRuntimeStateStore,
} from "@work-fabric/agent-runtime-spi";
import { describe, expect, it } from "vitest";

export interface PrivateStateStoreFixture {
  readonly store: AgentRuntimeStateStore & AgentPrivateStateStore;
  close(): Promise<void>;
}

const NOW = "2026-07-30T01:00:00.000Z";

export function verifyAgentPrivateStateStoreContract(
  name: string,
  create: () => Promise<PrivateStateStoreFixture>,
): void {
  describe(name, () => {
    it("creates at version zero and updates with optimistic compare-and-swap", async () => {
      const fixture = await create();
      try {
        const created = await fixture.store.putPrivateState({
          tenant_id: "tenant-1",
          namespace: "daily-assistant.scheduling/v1",
          key: "feishu-chat-1",
          expected_version: 0,
          value: { phase: "collecting_information" },
          updated_at: NOW,
        });
        expect(created).toEqual({
          tenant_id: "tenant-1",
          namespace: "daily-assistant.scheduling/v1",
          key: "feishu-chat-1",
          version: 1,
          value: { phase: "collecting_information" },
          updated_at: NOW,
        });
        const updated = await fixture.store.putPrivateState({
          tenant_id: "tenant-1",
          namespace: "daily-assistant.scheduling/v1",
          key: "feishu-chat-1",
          expected_version: 1,
          value: { phase: "awaiting_confirmation" },
          updated_at: "2026-07-30T01:00:01.000Z",
        });
        expect(updated.version).toBe(2);
        expect(updated.value).toEqual({
          phase: "awaiting_confirmation",
        });
        await expect(fixture.store.putPrivateState({
          tenant_id: "tenant-1",
          namespace: "daily-assistant.scheduling/v1",
          key: "feishu-chat-1",
          expected_version: 1,
          value: { phase: "completed" },
          updated_at: "2026-07-30T01:00:02.000Z",
        })).rejects.toMatchObject({
          name: "AgentPrivateStateConflictError",
        });
        expect((await fixture.store.getPrivateState(
          "tenant-1",
          "daily-assistant.scheduling/v1",
          "feishu-chat-1",
        ))?.value).toEqual({
          phase: "awaiting_confirmation",
        });
      } finally {
        await fixture.close();
      }
    });

    it("isolates tenant, namespace and key while returning defensive copies", async () => {
      const fixture = await create();
      try {
        const value = { nested: { proposal: "version-1" } };
        const first = await fixture.store.putPrivateState({
          tenant_id: "tenant-1",
          namespace: "daily-assistant.scheduling/v1",
          key: "conversation-1",
          expected_version: 0,
          value,
          updated_at: NOW,
        });
        await fixture.store.putPrivateState({
          tenant_id: "tenant-2",
          namespace: "daily-assistant.scheduling/v1",
          key: "conversation-1",
          expected_version: 0,
          value: { marker: "tenant-2" },
          updated_at: NOW,
        });
        await fixture.store.putPrivateState({
          tenant_id: "tenant-1",
          namespace: "another-agent/v1",
          key: "conversation-1",
          expected_version: 0,
          value: { marker: "other-namespace" },
          updated_at: NOW,
        });
        (value.nested as { proposal: string }).proposal = "changed-input";
        (first.value.nested as { proposal: string }).proposal =
          "changed-output";

        expect((await fixture.store.getPrivateState(
          "tenant-1",
          "daily-assistant.scheduling/v1",
          "conversation-1",
        ))?.value).toEqual({
          nested: { proposal: "version-1" },
        });
        expect((await fixture.store.getPrivateState(
          "tenant-2",
          "daily-assistant.scheduling/v1",
          "conversation-1",
        ))?.value).toEqual({ marker: "tenant-2" });
        expect((await fixture.store.getPrivateState(
          "tenant-1",
          "another-agent/v1",
          "conversation-1",
        ))?.value).toEqual({ marker: "other-namespace" });
        expect(await fixture.store.getPrivateState(
          "tenant-1",
          "daily-assistant.scheduling/v1",
          "missing",
        )).toBeNull();
      } finally {
        await fixture.close();
      }
    });

    it("rejects invalid identifiers, timestamps and unbounded JSON", async () => {
      const fixture = await create();
      try {
        const base = {
          tenant_id: "tenant-1",
          namespace: "daily-assistant.scheduling/v1",
          key: "conversation-1",
          expected_version: 0,
          value: { phase: "collecting_information" },
          updated_at: NOW,
        };
        await expect(fixture.store.putPrivateState({
          ...base,
          namespace: " daily-assistant.scheduling/v1",
        })).rejects.toThrow();
        await expect(fixture.store.putPrivateState({
          ...base,
          updated_at: "not-a-timestamp",
        })).rejects.toThrow();
        await expect(fixture.store.putPrivateState({
          ...base,
          value: { text: "x".repeat(131_073) },
        })).rejects.toThrow();
      } finally {
        await fixture.close();
      }
    });
  });
}
