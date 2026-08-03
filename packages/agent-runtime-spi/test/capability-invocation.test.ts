import { describe, expect, it } from "vitest";

import {
  validateCapabilityCandidate,
  validateCapabilityInvocationRequest,
  validateCapabilityInvocationResult,
  validateRuntimeCapabilitySummaries,
  validateRuntimeCapabilityContinuation,
  validateRuntimeCapabilityTranscript,
  validateRuntimeDriverTurn,
} from "../src/index.js";

const digest = `sha256:${"a".repeat(64)}` as const;

const candidate = {
  citizen_id: "feishu-document-actions",
  endpoint_id: "endpoint-feishu-provider",
  capability_id: "feishu.document.create",
  capability_version: "1.0.0",
  contract_digest: digest,
};

const request = {
  invocation_id: "invocation-01",
  original_handoff_id: "handoff-01",
  thread_id: "thread-01",
  capability_id: "feishu.document.create",
  version_constraint: "^1.0.0",
  input: {
    title: "Project brief",
    content: {
      media_type: "text/plain",
      text: "Create the project brief.",
    },
  },
  reason: "The user explicitly asked the assistant to create a document.",
  deadline: "2026-07-27T01:00:00.000Z",
};

describe("Agent capability invocation contracts", () => {
  it("validates and deeply freezes a request, candidate and successful result", () => {
    const validatedRequest = validateCapabilityInvocationRequest(request);
    const validatedCandidate = validateCapabilityCandidate(candidate);
    const validatedResult = validateCapabilityInvocationResult({
      outcome: "succeeded",
      invocation_id: request.invocation_id,
      auxiliary_handoff_id: "handoff-capability-01",
      candidate,
      data: {
        document_token: "docx-token",
        title: "Project brief",
      },
      artifacts: [{
        artifact_id: "artifact-document-01",
        media_type: "application/vnd.feishu.docx",
      }],
    });

    expect(validatedRequest).toEqual(request);
    expect(validatedCandidate).toEqual(candidate);
    expect(validatedResult).toMatchObject({
      outcome: "succeeded",
      candidate,
    });
    if (validatedResult.outcome !== "succeeded") {
      throw new Error("expected a successful invocation result");
    }
    expect(Object.isFrozen(validatedRequest)).toBe(true);
    expect(Object.isFrozen(validatedRequest.input.content)).toBe(true);
    expect(Object.isFrozen(validatedResult)).toBe(true);
    expect(Object.isFrozen(validatedResult.artifacts)).toBe(true);
  });

  it("validates a capability request turn and a typed continuation", () => {
    const turn = validateRuntimeDriverTurn({
      kind: "capability_request",
      request: {
        invocation_id: request.invocation_id,
        capability_id: request.capability_id,
        version_constraint: request.version_constraint,
        input: request.input,
        reason: request.reason,
      },
    });
    const result = validateCapabilityInvocationResult({
      outcome: "failed",
      invocation_id: request.invocation_id,
      auxiliary_handoff_id: "handoff-capability-01",
      code: "provider_unavailable",
      message: "The capability provider is temporarily unavailable.",
      retryable: true,
    });
    const continuation = validateRuntimeCapabilityContinuation({
      request: turn.kind === "capability_request" ? turn.request : {},
      result,
    });

    expect(turn.kind).toBe("capability_request");
    expect(continuation.result).toEqual(result);
    expect(Object.isFrozen(continuation)).toBe(true);
  });

  it("validates Host-owned invocation lineage and rejects correlation changes", () => {
    const result = validateCapabilityInvocationResult({
      outcome: "succeeded",
      invocation_id: request.invocation_id,
      auxiliary_handoff_id: "handoff-capability-01",
      candidate,
      data: { document_token: "docx-token" },
      artifacts: [],
    });
    const entry = {
      request: {
        invocation_id: request.invocation_id,
        capability_id: request.capability_id,
        version_constraint: request.version_constraint,
        input: request.input,
        reason: request.reason,
      },
      result,
      host_receipt: {
        operation_id: request.invocation_id,
        original_handoff_id: request.original_handoff_id,
        auxiliary_handoff_id: "handoff-capability-01",
        selected_candidate: candidate,
        started_at: "2026-07-27T00:00:00.000Z",
        received_at: "2026-07-27T00:00:01.000Z",
      },
    };

    expect(validateRuntimeCapabilityContinuation(entry)).toMatchObject({
      host_receipt: { selected_candidate: candidate },
    });
    expect(() => validateRuntimeCapabilityContinuation({
      ...entry,
      host_receipt: {
        ...entry.host_receipt,
        auxiliary_handoff_id: "handoff-other",
      },
    })).toThrow(/auxiliary_handoff_id.*match/i);
    expect(() => validateRuntimeCapabilityContinuation({
      ...entry,
      host_receipt: {
        ...entry.host_receipt,
        selected_candidate: { ...candidate, endpoint_id: "endpoint-other" },
      },
    })).toThrow(/selected_candidate.*match/i);
    expect(() => validateRuntimeCapabilityContinuation({
      ...entry,
      host_receipt: {
        ...entry.host_receipt,
        started_at: "2026-07-27T00:00:02.000Z",
      },
    })).toThrow(/received_at.*started_at/i);
  });

  it("validates a bounded, ordered capability transcript", () => {
    const entries = [1, 2].map((index) => ({
      request: {
        invocation_id: `invocation-${index}`,
        capability_id: "feishu.conversation.history.read",
        version_constraint: "1.0.0",
        input: { maximum_messages: 20 },
        reason: "Read another bounded page.",
      },
      result: {
        outcome: "failed" as const,
        invocation_id: `invocation-${index}`,
        auxiliary_handoff_id: null,
        code: "provider_unavailable",
        message: "Provider unavailable.",
        retryable: true,
      },
    }));

    const transcript = validateRuntimeCapabilityTranscript({ entries });

    expect(transcript.entries).toHaveLength(2);
    expect(transcript.entries[1]?.request.invocation_id).toBe("invocation-2");
    expect(Object.isFrozen(transcript.entries)).toBe(true);
  });

  it("rejects duplicate, oversized and secret-bearing transcripts", () => {
    const entry = {
      request: {
        invocation_id: "invocation-1",
        capability_id: "feishu.conversation.history.read",
        version_constraint: "1.0.0",
        input: { maximum_messages: 20 },
        reason: "Read another bounded page.",
      },
      result: {
        outcome: "failed",
        invocation_id: "invocation-1",
        auxiliary_handoff_id: null,
        code: "provider_unavailable",
        message: "Provider unavailable.",
        retryable: true,
      },
    };
    expect(() => validateRuntimeCapabilityTranscript({
      entries: [entry, entry],
    })).toThrow(/duplicate/i);
    expect(() => validateRuntimeCapabilityTranscript({
      entries: [{
        ...entry,
        request: {
          ...entry.request,
          input: { api_key: "forbidden" },
        },
      }],
    })).toThrow(/secret/i);
    expect(() => validateRuntimeCapabilityTranscript({
      entries: Array.from({ length: 9 }, (_, index) => ({
        ...entry,
        request: {
          ...entry.request,
          invocation_id: `invocation-${index}`,
        },
        result: {
          ...entry.result,
          invocation_id: `invocation-${index}`,
        },
      })),
    })).toThrow(/entries/i);
  });

  it("preserves the existing final result shape", () => {
    expect(validateRuntimeDriverTurn({
      kind: "final",
      response: {
        summary: [{
          kind: "text",
          media_type: "text/plain",
          text: "已创建项目简报。",
        }],
        artifacts: [],
        evidence: [],
        extensions: {},
      },
    })).toMatchObject({
      kind: "final",
      response: {
        summary: [{ text: "已创建项目简报。" }],
      },
    });
  });

  it("validates and freezes bounded public capability summaries", () => {
    const summaries = validateRuntimeCapabilitySummaries([{
      citizen_id: "feishu-document-actions",
      capability_id: "feishu.document.create",
      version: "1.0.0",
      name: "Create document",
      description: "Create one simple Docx document.",
      operation_kind: "command",
      input_schema: {
        type: "object",
        required: ["title", "content"],
      },
    }]);

    expect(summaries).toEqual([{
      citizen_id: "feishu-document-actions",
      capability_id: "feishu.document.create",
      version: "1.0.0",
      name: "Create document",
      description: "Create one simple Docx document.",
      operation_kind: "command",
      input_schema: {
        type: "object",
        required: ["title", "content"],
      },
    }]);
    expect(Object.isFrozen(summaries)).toBe(true);
    expect(Object.isFrozen(summaries[0])).toBe(true);
  });

  it.each([
    [[{
      citizen_id: "provider",
      capability_id: "feishu.document.create",
      version: "1.0.0",
      name: "Create",
      description: "Create.",
      operation_kind: "command",
      input_schema: null,
      folder_token: "secret",
    }], /fields/i],
    [Array.from({ length: 33 }, (_, index) => ({
      citizen_id: `provider-${index}`,
      capability_id: "feishu.document.create",
      version: "1.0.0",
      name: "Create",
      description: "Create.",
      operation_kind: "command",
      input_schema: null,
    })), /bounded/i],
    [[{
      citizen_id: "provider",
      capability_id: "feishu.document.create",
      version: "latest",
      name: "Create",
      description: "Create.",
      operation_kind: "command",
      input_schema: null,
    }], /version/i],
    [[{
      citizen_id: "provider",
      capability_id: "feishu.document.create",
      version: "1.0.0",
      name: "Create",
      description: "Create.",
      operation_kind: "mutation",
      input_schema: null,
    }], /operation_kind/i],
  ])("rejects unsafe capability summaries", (value, message) => {
    expect(() => validateRuntimeCapabilitySummaries(value)).toThrow(message);
  });

  it.each([
    [{ ...request, unexpected: true }, /fields/i],
    [{ ...request, capability_id: "document-create" }, /capability_id/i],
    [{ ...request, deadline: "tomorrow" }, /deadline/i],
    [{ ...request, reason: "x".repeat(8_193) }, /reason/i],
    [{ ...request, input: { constructor: "unsafe" } }, /unsafe/i],
  ])("rejects an invalid invocation request", (value, message) => {
    expect(() => validateCapabilityInvocationRequest(value)).toThrow(message);
  });

  it("rejects contract and invocation identity mismatches", () => {
    expect(() => validateCapabilityCandidate({
      ...candidate,
      contract_digest: "sha256:not-a-digest",
    })).toThrow(/contract_digest/i);

    expect(() => validateRuntimeCapabilityContinuation({
      request: {
        invocation_id: "invocation-01",
        capability_id: "feishu.document.create",
        version_constraint: "^1.0.0",
        input: {},
        reason: "Create the requested document.",
      },
      result: {
        outcome: "rejected",
        invocation_id: "invocation-02",
        auxiliary_handoff_id: null,
        code: "authority_denied",
        message: "Invocation is not authorized.",
        retryable: false,
      },
    })).toThrow(/invocation_id/i);
  });

  it("rejects accessors, cyclic JSON and unknown turn fields", () => {
    const accessor = {};
    Object.defineProperty(accessor, "secret", {
      enumerable: true,
      get() {
        return "not allowed";
      },
    });
    expect(() => validateCapabilityInvocationRequest({
      ...request,
      input: accessor,
    })).toThrow(/data property/i);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => validateCapabilityInvocationRequest({
      ...request,
      input: cyclic,
    })).toThrow(/reference|cyclic/i);

    expect(() => validateRuntimeDriverTurn({
      kind: "capability_request",
      request: {
        invocation_id: "invocation-01",
        capability_id: "feishu.document.create",
        version_constraint: "^1.0.0",
        input: {},
        reason: "Create the requested document.",
      },
      response: {},
    })).toThrow(/fields/i);
  });
});
