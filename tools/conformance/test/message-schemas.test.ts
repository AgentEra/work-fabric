import type { ErrorObject } from "ajv";
import { beforeAll, describe, expect, it } from "vitest";

import { loadSchemaRegistry } from "../src/schema-registry.js";

let registry: Awaited<ReturnType<typeof loadSchemaRegistry>>;

beforeAll(async () => {
  registry = await loadSchemaRegistry("protocol/schemas/v1");
});

function errors(schemaName: string, value: unknown): ErrorObject[] | null {
  const schemaId = `urn:work-fabric:schema:v1:${schemaName}`;
  const validator = registry.getSchema(schemaId);
  if (validator === undefined) {
    throw new Error(`Schema not registered: ${schemaId}`);
  }
  validator(value);
  return validator.errors ?? null;
}

const command = {
  spec_version: "1.0",
  message_id: "msg_01",
  message_type: "workfabric.handoff.accept.v1",
  sent_at: "2026-07-13T08:00:00Z",
  tenant_id: "tenant_01",
  exchange_id: "exchange_01",
  actor_id: "actor_agent_01",
  endpoint_id: "endpoint_runtime_01",
  delegation_id: "dlg_01",
  correlation_id: "corr_01",
  causation_id: "evt_handoff_offered_01",
  idempotency_key: "accept-handoff-42-attempt-1",
  expected_version: 3,
  trace_context: {
    traceparent:
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  },
  payload: {
    handoff_id: "handoff_42",
  },
  extensions: {},
};

const resource = {
  resource_type: "handoff",
  resource_id: "handoff_42",
  resource_version: 4,
};

const receipt = {
  receipt_id: "receipt_01",
  receipt_type: "responsibility_accepted",
  handoff_id: "handoff_42",
  actor_id: "actor_agent_01",
  endpoint_id: "endpoint_runtime_01",
  resource_version: 4,
  recorded_at: "2026-07-13T08:00:00Z",
  extensions: {},
};

const protocolError = {
  code: "version_conflict",
  message: "handoff version does not match expected_version",
  retryable: true,
  retry_after_seconds: null,
  current_resource_version: 5,
  field_violations: [],
  details: {},
  extensions: {},
};

describe("CommandEnvelope", () => {
  it("accepts a transport-neutral state-changing command", () => {
    expect(errors("command-envelope", command)).toBeNull();
  });

  it("requires an idempotency key", () => {
    const { idempotency_key: _omitted, ...invalid } = command;
    expect(errors("command-envelope", invalid)).not.toBeNull();
  });

  it("rejects a non-positive expected resource version", () => {
    expect(
      errors("command-envelope", { ...command, expected_version: 0 }),
    ).not.toBeNull();
  });
});

describe("OperationResult", () => {
  it("accepts an operation completed by the Exchange", () => {
    expect(
      errors("operation-result", {
        spec_version: "1.0",
        request_message_id: "msg_01",
        operation_status: "accepted",
        resource,
        receipt,
        error: null,
        extensions: {},
      }),
    ).toBeNull();
  });

  it("rejects an accepted operation carrying a protocol error", () => {
    expect(
      errors("operation-result", {
        spec_version: "1.0",
        request_message_id: "msg_01",
        operation_status: "accepted",
        resource,
        receipt,
        error: protocolError,
        extensions: {},
      }),
    ).not.toBeNull();
  });

  it("requires an error for a non-accepted operation", () => {
    expect(
      errors("operation-result", {
        spec_version: "1.0",
        request_message_id: "msg_01",
        operation_status: "conflict",
        resource: null,
        receipt: null,
        error: null,
        extensions: {},
      }),
    ).not.toBeNull();
  });

  it("accepts a version conflict result", () => {
    expect(
      errors("operation-result", {
        spec_version: "1.0",
        request_message_id: "msg_01",
        operation_status: "conflict",
        resource: null,
        receipt: null,
        error: protocolError,
        extensions: {},
      }),
    ).toBeNull();
  });
});

describe("ProtocolError", () => {
  it.each([
    "invalid_argument",
    "unauthenticated",
    "permission_denied",
    "not_found",
    "version_conflict",
    "invalid_state_transition",
    "idempotency_key_reused",
    "precondition_failed",
    "expired",
    "unsupported_version",
    "capability_unavailable",
    "context_unavailable",
    "cursor_expired",
    "rate_limited",
    "temporarily_unavailable",
    "internal",
  ])("accepts the normative %s error code", (code) => {
    expect(errors("protocol-error", { ...protocolError, code })).toBeNull();
  });

  it("rejects non-normative error codes", () => {
    expect(
      errors("protocol-error", { ...protocolError, code: "bad_request" }),
    ).not.toBeNull();
  });
});
