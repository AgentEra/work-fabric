import { beforeAll, describe, expect, it } from "vitest";
import { loadWfppSchemaValidator, type WfppSchemaValidator } from "@work-fabric/protocol-runtime";

import { resultPayload, statusPayload } from "../src/index.js";

describe("protocol mapping", () => {
  let schemas: WfppSchemaValidator;
  beforeAll(async () => { schemas = await loadWfppSchemaValidator("protocol/schemas/v1"); });

  it("maps bounded runtime progress into a status update", () => {
    const payload = statusPayload("handoff-1", {
      sequence: 2, progress: 0.5, message: "Working", observed_at: "2026-07-26T00:00:00.000Z",
    });
    expect(payload.status).toMatchObject({ status_report_id: "status:handoff-1:2", execution_status: "in_progress", progress: 0.5, message: [{ kind: "text", media_type: "text/plain", text: "Working" }], observed_at: "2026-07-26T00:00:00.000Z", blocked_on: [] });
    expect(schemas.validate("urn:work-fabric:schema:v1:handoff-status-command", payload)).toEqual({ valid: true });
  });

  it("maps a driver result without allowing forbidden extensions", () => {
    const payload = resultPayload("handoff-1", {
      summary: [{ kind: "text", media_type: "text/plain", text: "Completed" }], artifacts: [], evidence: [], extensions: { "workfabric.dev/runtime_execution_id": "run-1" },
    });
    expect(schemas.validate("urn:work-fabric:schema:v1:handoff-result-command", payload)).toEqual({ valid: true });
    expect(() => resultPayload("handoff-1", { summary: [], artifacts: [], evidence: [], extensions: {} })).toThrow("summary");
    expect(() => resultPayload("handoff-1", { summary: [{ kind: "text", media_type: "text/plain", text: "Completed" }], artifacts: [], evidence: [], extensions: { "runtime.execution_id": "secret" } })).toThrow("extensions");
  });
});
