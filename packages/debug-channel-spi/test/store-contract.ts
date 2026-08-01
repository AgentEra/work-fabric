import { expect, it } from "vitest";
import type {
  DebugCapture,
  DebugChannelStore,
  DebugSubmission,
} from "../src/index.js";

export interface DebugChannelStoreFixture {
  readonly store: DebugChannelStore;
  close(): Promise<void>;
}

export interface DebugChannelStoreFixtureFactory {
  create(): Promise<DebugChannelStoreFixture>;
}

const now = "2026-07-29T09:00:00.000Z";
const later = "2026-07-29T09:00:01.000Z";
const expiry = "2026-08-12T09:00:00.000Z";

function submission(digest = "a".repeat(64)): DebugSubmission {
  return {
    tenant_id: "tenant-local",
    plugin_instance_id: "debug-local",
    submission_id: "submission-1",
    conversation_id: "conversation-1",
    idempotency_key: "message-1",
    request_digest: digest,
    created_at: now,
    updated_at: now,
    expires_at: expiry,
  };
}

function capture(id = "capture-1", at = later): DebugCapture {
  return {
    tenant_id: "tenant-local",
    plugin_instance_id: "debug-local",
    capture_id: id,
    conversation_id: "conversation-1",
    event_id: `event-${id}`,
    destination_id: "handoff:handoff-1",
    event: {
      specversion: "1.0",
      id: `event-${id}`,
      source: "urn:work-fabric:exchange:exchange-local",
      type: "workfabric.handoff.result_returned.v1",
      subject: "urn:work-fabric:handoff:handoff-1",
      time: at,
      datacontenttype: "application/json",
      dataschema: "urn:work-fabric:schema:v1:events:handoff-result-returned",
      wftenant: "tenant-local",
      wfhandoff: "handoff-1",
      wfsequence: 3,
      data: { result: { summary: id } },
    },
    captured_at: at,
    expires_at: expiry,
  };
}

export function runDebugChannelStoreContract(
  factory: DebugChannelStoreFixtureFactory,
): void {
  it("creates, replays and conflicts one submission identity", async () => {
    const fixture = await factory.create();
    try {
      expect((await fixture.store.createSubmission({ submission: submission() })).kind).toBe("created");
      expect((await fixture.store.createSubmission({ submission: submission() })).kind).toBe("existing");
      expect((await fixture.store.createSubmission({
        submission: submission("b".repeat(64)),
      })).kind).toBe("conflict");
    } finally {
      await fixture.close();
    }
  });

  it("links ingress and handoff once without allowing correlation drift", async () => {
    const fixture = await factory.create();
    try {
      await fixture.store.createSubmission({ submission: submission() });
      const scope = {
        tenant_id: "tenant-local",
        plugin_instance_id: "debug-local",
        submission_id: "submission-1",
      };
      expect((await fixture.store.linkIngress({
        ...scope,
        ingress_id: "ingress-1",
        updated_at: later,
      })).ingress_id).toBe("ingress-1");
      await expect(fixture.store.linkIngress({
        ...scope,
        ingress_id: "ingress-2",
        updated_at: "2026-07-29T09:00:02.000Z",
      })).rejects.toMatchObject({ code: "ingress_conflict" });
      expect((await fixture.store.linkHandoff({
        ...scope,
        handoff_id: "handoff-1",
        updated_at: "2026-07-29T09:00:02.000Z",
      })).handoff_id).toBe("handoff-1");
      await expect(fixture.store.linkHandoff({
        ...scope,
        handoff_id: "handoff-2",
        updated_at: "2026-07-29T09:00:03.000Z",
      })).rejects.toMatchObject({ code: "handoff_conflict" });
    } finally {
      await fixture.close();
    }
  });

  it("captures one event idempotently and isolates returned values", async () => {
    const fixture = await factory.create();
    try {
      expect((await fixture.store.appendCapture({ capture: capture() })).kind).toBe("created");
      expect((await fixture.store.appendCapture({ capture: capture() })).kind).toBe("existing");
      const loaded = await fixture.store.getCapture({
        tenant_id: "tenant-local",
        plugin_instance_id: "debug-local",
        capture_id: "capture-1",
      });
      expect(loaded).not.toBeNull();
      (loaded!.event.data as { result: { summary: string } }).result.summary = "mutated";
      const reloaded = await fixture.store.getCapture({
        tenant_id: "tenant-local",
        plugin_instance_id: "debug-local",
        capture_id: "capture-1",
      });
      expect((reloaded!.event.data as { result: { summary: string } }).result.summary).toBe("capture-1");
    } finally {
      await fixture.close();
    }
  });

  it("lists captures deterministically after an exclusive tuple", async () => {
    const fixture = await factory.create();
    try {
      await fixture.store.appendCapture({ capture: capture("capture-b", "2026-07-29T09:00:02.000Z") });
      await fixture.store.appendCapture({ capture: capture("capture-a", "2026-07-29T09:00:02.000Z") });
      await fixture.store.appendCapture({ capture: capture("capture-c", "2026-07-29T09:00:03.000Z") });
      const first = await fixture.store.listCaptures({
        tenant_id: "tenant-local",
        plugin_instance_id: "debug-local",
        conversation_id: "conversation-1",
        limit: 2,
      });
      expect(first.items.map((item) => item.capture_id)).toEqual(["capture-a", "capture-b"]);
      const second = await fixture.store.listCaptures({
        tenant_id: "tenant-local",
        plugin_instance_id: "debug-local",
        conversation_id: "conversation-1",
        after_captured_at: "2026-07-29T09:00:02.000Z",
        after_capture_id: "capture-b",
        limit: 2,
      });
      expect(second.items.map((item) => item.capture_id)).toEqual(["capture-c"]);
    } finally {
      await fixture.close();
    }
  });

  it("prunes only expired records within the requested bound", async () => {
    const fixture = await factory.create();
    try {
      await fixture.store.createSubmission({
        submission: { ...submission(), expires_at: "2026-07-29T09:00:03.000Z" },
      });
      await fixture.store.appendCapture({
        capture: { ...capture(), expires_at: "2026-07-29T09:00:03.000Z" },
      });
      expect(await fixture.store.pruneExpired({
        tenant_id: "tenant-local",
        plugin_instance_id: "debug-local",
        now: "2026-07-29T09:00:04.000Z",
        limit: 1,
      })).toEqual({ submissions: 0, captures: 1 });
      expect(await fixture.store.pruneExpired({
        tenant_id: "tenant-local",
        plugin_instance_id: "debug-local",
        now: "2026-07-29T09:00:04.000Z",
        limit: 1,
      })).toEqual({ submissions: 1, captures: 0 });
    } finally {
      await fixture.close();
    }
  });
}
