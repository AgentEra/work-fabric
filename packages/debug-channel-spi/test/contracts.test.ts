import { describe, expect, it } from "vitest";
import {
  DEBUG_CHANNEL_STORE_REQUIRED_CAPABILITIES,
  DebugChannelStoreError,
  assertDebugCapture,
  assertDebugSubmission,
  debugChannelStoreManifest,
  type DebugCapture,
  type DebugSubmission,
} from "../src/index.js";

function submission(): DebugSubmission {
  return {
    tenant_id: "tenant-local",
    plugin_instance_id: "debug-local",
    submission_id: "submission-1",
    conversation_id: "conversation-1",
    idempotency_key: "message-1",
    request_digest: "a".repeat(64),
    created_at: "2026-07-29T09:00:00.000Z",
    updated_at: "2026-07-29T09:00:00.000Z",
    expires_at: "2026-08-12T09:00:00.000Z",
  };
}

function capture(): DebugCapture {
  return {
    tenant_id: "tenant-local",
    plugin_instance_id: "debug-local",
    capture_id: "capture-1",
    conversation_id: "conversation-1",
    event_id: "event-1",
    destination_id: "handoff:handoff-1",
    event: {
      specversion: "1.0",
      id: "event-1",
      source: "urn:work-fabric:exchange:exchange-local",
      type: "workfabric.handoff.result_returned.v1",
      subject: "urn:work-fabric:handoff:handoff-1",
      time: "2026-07-29T09:01:00.000Z",
      datacontenttype: "application/json",
      dataschema: "urn:work-fabric:schema:v1:events:handoff-result-returned",
      wftenant: "tenant-local",
      wfhandoff: "handoff-1",
      wfsequence: 3,
      data: { result: { summary: "captured" } },
    },
    captured_at: "2026-07-29T09:01:01.000Z",
    expires_at: "2026-08-12T09:01:01.000Z",
  };
}

describe("Debug Channel contracts", () => {
  it("accepts a submission before ingress and handoff correlation exists", () => {
    expect(() => assertDebugSubmission(submission())).not.toThrow();
  });

  it("accepts a submission after ingress and handoff correlation is linked", () => {
    expect(() => assertDebugSubmission({
      ...submission(),
      ingress_id: "sqlite_ingress_1",
      handoff_id: "handoff-1",
      updated_at: "2026-07-29T09:00:02.000Z",
    })).not.toThrow();
  });

  it("rejects unknown submission fields", () => {
    expect(() => assertDebugSubmission({
      ...submission(),
      token: "must-not-be-stored",
    })).toThrow("unknown or missing fields");
  });

  it("rejects a non-sha256 request digest", () => {
    expect(() => assertDebugSubmission({
      ...submission(),
      request_digest: "digest",
    })).toThrow("request_digest");
  });

  it("rejects timestamps whose lifecycle order moves backwards", () => {
    expect(() => assertDebugSubmission({
      ...submission(),
      updated_at: "2026-07-28T09:00:00.000Z",
    })).toThrow("timestamp order");
  });

  it("accepts a canonical protocol event capture", () => {
    expect(() => assertDebugCapture(capture())).not.toThrow();
  });

  it("rejects a capture whose event identity differs", () => {
    expect(() => assertDebugCapture({
      ...capture(),
      event_id: "event-other",
    })).toThrow("event_id");
  });

  it("rejects non-JSON values inside a captured event", () => {
    const invalid = capture() as unknown as {
      event: { data: Record<string, unknown> };
    };
    invalid.event.data.result = undefined;
    expect(() => assertDebugCapture(invalid)).toThrow("JSON");
  });

  it("declares every required store capability", () => {
    const manifest = debugChannelStoreManifest("memory");
    expect(manifest.profile).toBe("debug.channel-store.v1");
    expect(manifest.adapter).toBe("memory");
    expect(
      DEBUG_CHANNEL_STORE_REQUIRED_CAPABILITIES.every(
        (capability) => manifest.capabilities[capability] === true,
      ),
    ).toBe(true);
  });

  it("exposes bounded typed store failures", () => {
    const error = new DebugChannelStoreError("ingress_conflict");
    expect(error).toMatchObject({
      name: "DebugChannelStoreError",
      message: "ingress_conflict",
      code: "ingress_conflict",
    });
  });
});
