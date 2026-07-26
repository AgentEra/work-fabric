import { describe, expect, it } from "vitest";

import { resultPayload, statusPayload } from "../src/index.js";

describe("protocol mapping", () => {
  it("maps bounded runtime progress into a status update", () => {
    expect(statusPayload("handoff-1", {
      sequence: 2, progress: 0.5, message: "Working", observed_at: "2026-07-26T00:00:00.000Z",
    })).toEqual({ handoff_id: "handoff-1", status: {
      phase: "in_progress", sequence: 2, progress: 0.5, message: "Working", observed_at: "2026-07-26T00:00:00.000Z",
    } });
  });

  it("maps a driver result without allowing forbidden extensions", () => {
    expect(resultPayload("handoff-1", {
      summary: [{ type: "text", text: "Completed" }], artifacts: [], evidence: [], extensions: { "runtime.execution_id": "run-1" },
    })).toEqual({ handoff_id: "handoff-1", result: {
      summary: [{ type: "text", text: "Completed" }], artifacts: [], evidence: [], extensions: { "runtime.execution_id": "run-1" },
    } });
    expect(() => resultPayload("handoff-1", { summary: [], artifacts: [], evidence: [], extensions: {} })).toThrow("summary");
    expect(() => resultPayload("handoff-1", { summary: [{ type: "text" }], artifacts: [], evidence: [], extensions: { token: "secret" } })).toThrow("extensions");
  });
});
