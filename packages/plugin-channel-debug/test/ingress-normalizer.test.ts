import { describe, expect, it } from "vitest";
import {
  debugMessageIngress,
  normalizeDebugMessage,
} from "../src/index.js";
import { validDebugConfig } from "./fixtures.js";

describe("debugMessageIngress", () => {
  it("creates a deterministic isolated Connector ingress envelope", () => {
    const message = normalizeDebugMessage({
      idempotency_key: "message-1",
      participant_ref: "internal-user",
      content: [
        { kind: "text", media_type: "text/markdown", text: "总结 **EDA**" },
        {
          kind: "data",
          schema_ref: "https://schemas.example.test/eda/v1",
          data: { status: "draft" },
        },
      ],
    }, validDebugConfig().limits);
    expect(debugMessageIngress({
      tenant_id: "tenant-local",
      connector_id: "debug-local",
      external_tenant_id: "debug-fixtures",
      submission_id: "submission-1",
      conversation_id: "conversation-1",
      message,
      occurred_at: "2026-07-29T09:00:00.000Z",
      received_at: "2026-07-29T09:00:01.000Z",
    })).toEqual({
      tenant_id: "tenant-local",
      connector_id: "debug-local",
      source_system: "workfabric-debug",
      external_tenant_id: "debug-fixtures",
      external_event_id: "submission-1",
      dedupe_key: "workfabric-debug:debug-local:submission-1",
      event_type: "debug.message.receive_v1",
      partition_key: "conversation-1",
      occurred_at: "2026-07-29T09:00:00.000Z",
      received_at: "2026-07-29T09:00:01.000Z",
      payload: {
        submission_id: "submission-1",
        conversation_id: "conversation-1",
        idempotency_key: "message-1",
        participant_ref: "internal-user",
        content: [
          { kind: "text", media_type: "text/markdown", text: "总结 **EDA**" },
          {
            kind: "data",
            schema_ref: "https://schemas.example.test/eda/v1",
            data: { status: "draft" },
          },
        ],
      },
    });
  });

  it("rejects a scope mismatch before creating ingress", () => {
    const message = normalizeDebugMessage({
      idempotency_key: "message-1",
      participant_ref: "internal-user",
      content: [{ kind: "text", media_type: "text/plain", text: "hello" }],
    }, validDebugConfig().limits);
    expect(() => debugMessageIngress({
      tenant_id: "tenant-local",
      connector_id: " debug-local ",
      external_tenant_id: "debug-fixtures",
      submission_id: "submission-1",
      conversation_id: "conversation-1",
      message,
      occurred_at: "2026-07-29T09:00:00.000Z",
      received_at: "2026-07-29T09:00:01.000Z",
    })).toThrow("connector_id");
  });
});
