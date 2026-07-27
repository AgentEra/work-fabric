import { describe, expect, it, vi } from "vitest";
import { canonicalCitizenDigest } from "@work-fabric/network-citizen-spi";

import { MemoryAgentRuntimeStateStore } from "@work-fabric/adapter-agent-runtime-memory";
import {
  HandoffCapabilityInvocationPort,
  JsonSchemaInvocationValidator,
  type BoundCapabilityContract,
} from "@work-fabric/agent-capability-runtime";
import type {
  RuntimeJsonObject,
  RuntimeTaskPackage,
} from "@work-fabric/agent-runtime-spi";
import {
  FeishuCapabilityExecutor,
  FeishuCapabilityExecutorPortAdapter,
  FeishuCapabilitySchemaRegistry,
  MemoryFeishuProviderStore,
  feishuCapabilityDeclarations,
  type FeishuCapabilityBackend,
} from "@work-fabric/provider-feishu";

import { CapabilityProviderDriver } from "../src/index.js";

describe("Agent -> auxiliary Handoff -> Feishu Provider loop", () => {
  it("returns Provider facts to the Agent continuation without moving original responsibility", async () => {
    const declaration = feishuCapabilityDeclarations().find((item) =>
      item.declaration_id === "feishu.document.create"
    )!;
    const candidate = {
      citizen_id: "feishu-actions",
      endpoint_id: "endpoint-feishu-actions",
      capability_id: declaration.declaration_id,
      capability_version: declaration.version,
      contract_digest: canonicalCitizenDigest(declaration),
    };
    const contract: BoundCapabilityContract = {
      candidate,
      input_schema: declaration.input_schema!,
      output_schema: declaration.output_schema!,
      confirmation: declaration.confirmation,
      risk: declaration.risk,
    };
    const backend: FeishuCapabilityBackend = {
      createDocument: vi.fn(async (input) => ({
        document_token: "doc-1",
        url: "https://feishu.example/docx/doc-1",
        title: input.title,
        revision: "1",
      })),
      sendMessage: vi.fn(),
      readDocument: vi.fn(),
      replaceDocument: vi.fn(),
      appendDocument: vi.fn(),
      deleteDocument: vi.fn(),
    };
    const store = new MemoryFeishuProviderStore();
    const provider = new FeishuCapabilityExecutor({
      citizen_id: candidate.citizen_id,
      endpoint_id: candidate.endpoint_id,
      backend,
      executions: store,
      ownership: store,
      confirmation: { consume: async () => false },
      targets: {
        resolveCurrentConversation: async () => ({
          kind: "chat_id",
          id: "chat-1",
        }),
      },
      now: () => "2026-07-27T10:00:01.000Z",
    });
    const providerDriver = new CapabilityProviderDriver({
      citizen_id: candidate.citizen_id,
      endpoint_id: candidate.endpoint_id,
      capabilities: [candidate.capability_id],
      executor: new FeishuCapabilityExecutorPortAdapter(provider),
    });
    let offered: Record<string, unknown> | null = null;
    const originalResponsibleActor = "actor-daily-assistant";
    const invocationPort = new HandoffCapabilityInvocationPort({
      tenant_id: "tenant-a",
      owner_id: "daily-assistant:invocations",
      verifier: {
        actor_id: "actor-daily-assistant",
        actor_type: "agent",
      },
      resolver: {
        discover: async () => [candidate],
        getBoundContract: async () => contract,
      },
      schemas: new JsonSchemaInvocationValidator(
        new FeishuCapabilitySchemaRegistry(),
      ),
      authority: {
        authorize: async ({ request }) => ({
          delegation_id: "delegation-capability-1",
          scopes: ["capability:invoke"],
          resource_refs: [
            `urn:work-fabric:capability-invocation:${request.original_handoff_id}:${request.invocation_id}`,
          ],
          expires_at: request.deadline,
          may_redelegate: false,
          extensions: {
            "workfabric.dev/capability_authority": {
              original_handoff_id: request.original_handoff_id,
              invocation_id: request.invocation_id,
              initiating_actor_id: "human-1",
              capability_version: candidate.capability_version,
              contract_digest: candidate.contract_digest,
              allowed_target_refs: [],
              allowed_document_tokens: [],
              confirmation_proof_refs: [],
            },
          },
        }),
      },
      handoffs: {
        offer: async (payload) => {
          offered = payload;
          return {
            spec_version: "1.0",
            request_message_id: "message-offer",
            operation_status: "accepted",
            resource: {
              resource_type: "handoff",
              resource_id: "handoff-aux",
              resource_version: 1,
            },
            receipt: null,
            error: null,
          };
        },
        resolveTarget: async () => ({
          spec_version: "1.0",
          request_message_id: "message-resolve",
          operation_status: "accepted",
          resource: {
            resource_type: "handoff",
            resource_id: "handoff-aux",
            resource_version: 2,
          },
          receipt: null,
          error: null,
        }),
        getHandoff: async () => {
          throw new Error("not used");
        },
      },
      waiter: {
        wait: async () => {
          if (offered === null) throw new Error("missing auxiliary offer");
          const payload = offered as {
            thread_id: string;
            intent: RuntimeTaskPackage["intent"];
            authority_scope: RuntimeTaskPackage["authority_scope"];
            accept_by: string;
            result_due_at: string;
          };
          const result = await providerDriver.execute({
            tenant_id: "tenant-a",
            handoff_id: "handoff-aux",
            thread_id: payload.thread_id,
            stream_version: 2,
            role: {
              role_id: "feishu-provider",
              version: 1,
              display_name: "Feishu Provider",
              description: "typed capability provider",
              capability_ids: [candidate.capability_id],
            },
            capability_id: candidate.capability_id,
            intent: payload.intent,
            context_reference: null,
            authority_scope: payload.authority_scope,
            acceptance_criteria: [],
            priority: "normal",
            accept_by: payload.accept_by,
            result_due_at: payload.result_due_at,
            workspace_path: "/tmp/provider",
          }, async () => undefined, new AbortController().signal);
          const data = result.summary[0]?.data as {
            outcome: "succeeded";
            data: RuntimeJsonObject;
            artifacts: readonly RuntimeJsonObject[];
          };
          return data;
        },
      },
      state: new MemoryAgentRuntimeStateStore(),
      now: () => "2026-07-27T10:00:00.000Z",
    });

    const result = await invocationPort.invoke({
      invocation_id: "invocation-1",
      original_handoff_id: "handoff-original",
      thread_id: "thread-1",
      capability_id: "feishu.document.create",
      version_constraint: "1.0.0",
      input: {
        title: "客户项目需求",
        content: { media_type: "text/markdown", text: "# 需求" },
      },
      reason: "建立共享需求文档",
      deadline: "2026-07-27T10:01:00.000Z",
    }, new AbortController().signal);

    expect(result).toMatchObject({
      outcome: "succeeded",
      auxiliary_handoff_id: "handoff-aux",
      data: {
        document_token: "doc-1",
        title: "客户项目需求",
        revision: "1",
      },
    });
    expect(originalResponsibleActor).toBe("actor-daily-assistant");
    expect(JSON.stringify({ offered, result })).not.toMatch(
      /app_secret|access_token|credential_ref/i,
    );
  });
});
