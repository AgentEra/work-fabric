import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { MemoryAgentRuntimeStateStore } from "@work-fabric/adapter-agent-runtime-memory";
import type {
  CapabilityCandidate,
  CapabilityInvocationRequest,
  RuntimeJsonObject,
} from "@work-fabric/agent-runtime-spi";
import type {
  ExistingHandoffCommandOptions,
  HandoffOfferPayload,
  HandoffTargetResolutionPayload,
  NewCommandOptions,
} from "@work-fabric/sdk-typescript";

import {
  HandoffCapabilityInvocationPort,
  type AuxiliaryHandoffTerminal,
  type BoundCapabilityContract,
} from "../src/index.js";

const candidate: CapabilityCandidate = {
  citizen_id: "citizen-feishu",
  endpoint_id: "endpoint-feishu",
  capability_id: "feishu.document.create",
  capability_version: "1.0.0",
  contract_digest:
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

const contract: BoundCapabilityContract = {
  candidate,
  input_schema: {
    uri: "https://work-fabric.example/schemas/feishu-document-create-input.json",
    digest:
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  },
  output_schema: {
    uri: "https://work-fabric.example/schemas/feishu-document-create-output.json",
    digest:
      "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  },
  confirmation: "none",
  risk: "medium",
};

const request: CapabilityInvocationRequest = {
  invocation_id: "invocation-create-1",
  original_handoff_id: "handoff-original-1",
  thread_id: "thread-1",
  capability_id: "feishu.document.create",
  version_constraint: "^1.0.0",
  input: { title: "客户项目需求" },
  reason: "创建协作文档",
  deadline: "2026-07-27T12:00:00.000Z",
};

function operation(
  status: "accepted" | "conflict" = "accepted",
  resource: RuntimeJsonObject | null = {
    resource_id: "handoff-auxiliary-1",
    resource_version: 1,
  },
) {
  return {
    spec_version: "1.0" as const,
    request_message_id: "message-1",
    operation_status: status,
    resource,
    receipt: null,
    error: null,
  };
}

function dependencies(
  terminal: AuxiliaryHandoffTerminal = {
    outcome: "succeeded",
    data: { document_id: "doc-1", url: "https://feishu.example/doc-1" },
    artifacts: [{ uri: "feishu://document/doc-1" }],
  },
) {
  const store = new MemoryAgentRuntimeStateStore();
  const resolver = {
    discover: vi.fn(async () => [candidate]),
    getBoundContract: vi.fn(async () => contract),
  };
  const schemas = {
    validateInput: vi.fn(async () => undefined),
    validateOutput: vi.fn(async (_contract, data, artifacts) => ({
      data,
      artifacts,
    })),
  };
  const authority = {
    authorize: vi.fn(async () => ({
      delegation_id: "delegation-invocation-1",
      scopes: ["feishu.document.create:invoke"],
      resource_refs: ["urn:work-fabric:capability-invocation:handoff-original-1:invocation-create-1"],
      expires_at: request.deadline,
      may_redelegate: false,
    })),
  };
  const handoffs = {
    offer: vi.fn(async (
      _payload: HandoffOfferPayload,
      _options: NewCommandOptions,
    ) => operation()),
    resolveTarget: vi.fn(async (
      _payload: HandoffTargetResolutionPayload,
      _options: ExistingHandoffCommandOptions,
    ) => operation("accepted", {
        resource_id: "handoff-auxiliary-1",
        resource_version: 2,
      })),
    getHandoff: vi.fn(async () => ({
      tenant_id: "tenant-1",
      partition_id: "partition-1",
      handoff_id: "handoff-auxiliary-1",
      stream_version: 1,
      state: { lifecycle_state: "target_resolution_pending" },
      latest_status: null,
    })),
  };
  const waiter = { wait: vi.fn(async () => terminal) };
  const port = new HandoffCapabilityInvocationPort({
    tenant_id: "tenant-1",
    owner_id: "agent-capability-runtime-1",
    verifier: { actor_id: "agent-daily-assistant", actor_type: "agent" },
    resolver,
    schemas,
    authority,
    handoffs,
    waiter,
    state: store,
    now: () => "2026-07-27T10:00:00.000Z",
  });
  return { port, store, resolver, schemas, authority, handoffs, waiter };
}

describe("HandoffCapabilityInvocationPort", () => {
  it("executes a selected capability through an auxiliary Handoff and returns typed facts", async () => {
    const deps = dependencies();

    const result = await deps.port.invoke(request, new AbortController().signal);

    expect(result).toEqual({
      outcome: "succeeded",
      invocation_id: request.invocation_id,
      auxiliary_handoff_id: "handoff-auxiliary-1",
      candidate,
      data: { document_id: "doc-1", url: "https://feishu.example/doc-1" },
      artifacts: [{ uri: "feishu://document/doc-1" }],
    });
    expect(deps.schemas.validateInput).toHaveBeenCalledWith(
      contract,
      request.input,
      expect.any(AbortSignal),
    );
    expect(deps.authority.authorize).toHaveBeenCalledWith({
      tenant_id: "tenant-1",
      request,
      candidate,
      contract,
      work_reference_uri:
        "urn:work-fabric:capability-invocation:handoff-original-1:invocation-create-1",
    }, expect.any(AbortSignal));
    expect(deps.handoffs.offer.mock.calls[0]?.[0]).toMatchObject({
      thread_id: request.thread_id,
      work_reference: {
        uri: "urn:work-fabric:capability-invocation:handoff-original-1:invocation-create-1",
        extensions: {
          "workfabric.dev/original_handoff_id": request.original_handoff_id,
          "workfabric.dev/invocation_id": request.invocation_id,
        },
      },
      target: {
        capability_requirement: {
          capability_id: request.capability_id,
          version_constraint: request.version_constraint,
          assignment_mode: "external_resolution",
          constraints: {
            selected_citizen_id: candidate.citizen_id,
            contract_digest: candidate.contract_digest,
          },
        },
      },
      acceptance_criteria: [{
        extensions: {
          "workfabric.dev/contract_digest": candidate.contract_digest,
        },
      }],
      result_due_at: request.deadline,
    });
    expect(deps.handoffs.resolveTarget).toHaveBeenCalledWith({
      handoff_id: "handoff-auxiliary-1",
      resolved_target: { endpoint_id: candidate.endpoint_id },
      evidence: [{
        evidence_id:
          "capability-binding-10ac72268c6cd1b81f96e26da2943249",
        evidence_type: "contract_binding",
        content: {
          kind: "data",
          schema_ref:
            "urn:work-fabric:schema:network-citizen-contract-binding:1",
          data: {
            citizen_id: candidate.citizen_id,
            declaration_id: candidate.capability_id,
            declaration_version: candidate.capability_version,
            contract_digest: candidate.contract_digest,
          },
        },
      }],
    }, expect.objectContaining({ expectedVersion: 1 }));
  });

  it("returns a persisted terminal result without repeating external work", async () => {
    const deps = dependencies();

    const first = await deps.port.invoke(request, new AbortController().signal);
    const second = await deps.port.invoke(request, new AbortController().signal);

    expect(second).toEqual(first);
    expect(deps.handoffs.offer).toHaveBeenCalledTimes(1);
    expect(deps.waiter.wait).toHaveBeenCalledTimes(1);
  });

  it("fails closed before offering when discovery returns no authorized candidate", async () => {
    const deps = dependencies();
    deps.resolver.discover.mockResolvedValueOnce([]);

    await expect(
      deps.port.invoke(request, new AbortController().signal),
    ).resolves.toMatchObject({
      outcome: "failed",
      auxiliary_handoff_id: null,
      code: "capability_unavailable",
      retryable: true,
    });
    expect(deps.handoffs.offer).not.toHaveBeenCalled();
  });

  it("fails closed when Provider output violates the bound output contract", async () => {
    const deps = dependencies();
    deps.schemas.validateOutput.mockRejectedValueOnce(
      new TypeError("output schema mismatch"),
    );

    await expect(
      deps.port.invoke(request, new AbortController().signal),
    ).resolves.toMatchObject({
      outcome: "failed",
      auxiliary_handoff_id: "handoff-auxiliary-1",
      code: "capability_output_invalid",
      retryable: false,
    });
  });

  it("rejects an expired deadline without discovery or an auxiliary Handoff", async () => {
    const deps = dependencies();

    await expect(
      deps.port.invoke(
        { ...request, deadline: "2026-07-27T09:59:59.000Z" },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      outcome: "failed",
      code: "capability_deadline_exceeded",
      auxiliary_handoff_id: null,
    });
    expect(deps.resolver.discover).not.toHaveBeenCalled();
    expect(deps.handoffs.offer).not.toHaveBeenCalled();
  });

  it("uses the immutable request digest for invocation idempotency", async () => {
    const deps = dependencies();
    await deps.port.invoke(request, new AbortController().signal);

    const record = await deps.store.getInvocation(
      "tenant-1",
      request.original_handoff_id,
      request.invocation_id,
    );
    expect(record?.request_digest).toBe(
      `sha256:${createHash("sha256")
        .update(JSON.stringify(request))
        .digest("hex")}`,
    );
  });
});
