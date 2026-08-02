import { describe, expect, it } from "vitest";
import { canonicalCitizenDigest } from "@work-fabric/network-citizen-spi";

import { MemoryAgentRuntimeStateStore } from "@work-fabric/adapter-agent-runtime-memory";
import {
  HandoffCapabilityInvocationPort,
  JsonSchemaInvocationValidator,
  type BoundCapabilityContract,
} from "@work-fabric/agent-capability-runtime";
import type { RuntimeJsonObject, RuntimeTaskPackage } from "@work-fabric/agent-runtime-spi";
import {
  GitHubCapabilityExecutor,
  GitHubCapabilitySchemaRegistry,
  GitHubPolicyEvaluator,
  GitHubQueryService,
  HmacGitHubCursorCodec,
  githubReadCapabilityDeclarations,
  type GitHubPullRequestRecord,
  type GitHubReadApi,
} from "@work-fabric/provider-github";

import { CapabilityProviderDriver } from "../src/index.js";

const repository = { owner: "AgentEra", name: "work-fabric" } as const;
const pullRequests: readonly GitHubPullRequestRecord[] = [1, 2].map((number) => ({
  repository,
  number,
  title: `PR ${number}`,
  url: `https://github.com/AgentEra/work-fabric/pull/${number}`,
  author: "octocat",
  draft: false,
  base_branch: "main",
  head_branch: `feature-${number}`,
  assignees: [],
  requested_reviewers: [],
  labels: [],
  mergeable: true,
  created_at: `2026-08-0${number}T09:00:00.000Z`,
  updated_at: `2026-08-0${number}T10:00:00.000Z`,
}));

function readApi(): GitHubReadApi {
  const unused = async (): Promise<never> => { throw new Error("unexpected GitHub API call"); };
  return {
    getIdentity: unused,
    listRepositories: unused,
    getRepository: unused,
    listPullRequests: unused,
    searchPullRequests: async () => ({ items: pullRequests }),
    getPullRequest: unused,
    listReviews: unused,
    listIssueComments: unused,
    listReviewComments: unused,
    listFiles: unused,
    listPullRequestCommits: unused,
    getChecks: unused,
    listWorkflowRuns: unused,
    listCommits: unused,
  };
}

describe("Agent -> auxiliary Handoff -> GitHub Provider loop", () => {
  it("returns two current PR facts while the Daily Assistant keeps original responsibility", async () => {
    const declaration = githubReadCapabilityDeclarations().find((item) =>
      item.declaration_id === "github.pull_request.list"
    )!;
    const candidate = {
      citizen_id: "github-read-provider",
      endpoint_id: "endpoint-github-provider",
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
      operation_kind: "query",
    };
    const query = new GitHubQueryService({
      api: readApi(),
      policy: new GitHubPolicyEvaluator({
        allowed_owners: ["AgentEra"],
        allowed_repositories: [repository],
        maximum_page_size: 30,
        maximum_aggregate_repositories: 10,
      }),
      cursor: new HmacGitHubCursorCodec({ key: Buffer.alloc(32, 4) }),
      api_version: "2022-11-28",
      now: () => "2026-08-02T10:00:01.000Z",
    });
    const executor = new GitHubCapabilityExecutor({
      query_service: query,
      installation_id_hash: "sha256:installation",
      now: () => "2026-08-02T10:00:01.000Z",
    });
    const providerDriver = new CapabilityProviderDriver({
      citizen_id: candidate.citizen_id,
      endpoint_id: candidate.endpoint_id,
      capabilities: [candidate.capability_id],
      executor,
    });
    let offered: Record<string, unknown> | null = null;
    let discoveredCapability: string | null = null;
    const originalResponsibleActor = "actor-daily-assistant";
    const invocationPort = new HandoffCapabilityInvocationPort({
      tenant_id: "tenant-a",
      owner_id: "daily-assistant:invocations",
      verifier: { actor_id: originalResponsibleActor, actor_type: "agent" },
      resolver: {
        discover: async (requirement) => {
          discoveredCapability = requirement.capability_id;
          return [candidate];
        },
        getBoundContract: async () => contract,
      },
      schemas: new JsonSchemaInvocationValidator(new GitHubCapabilitySchemaRegistry()),
      authority: {
        authorize: async ({ request }) => ({
          delegation_id: "delegation-github-1",
          scopes: ["capability:invoke", "github:read"],
          resource_refs: [
            `urn:work-fabric:capability-invocation:${request.original_handoff_id}:${request.invocation_id}`,
          ],
          expires_at: request.deadline,
          may_redelegate: false,
          extensions: {
            "workfabric.dev/capability_authority": {
              original_handoff_id: request.original_handoff_id,
              invocation_id: request.invocation_id,
              represented_actor_id: "human-1",
              delegation_id: "delegation-github-1",
              delegation_scopes: ["github:read"],
              delegation_expires_at: request.deadline,
              capability_version: candidate.capability_version,
              contract_digest: candidate.contract_digest,
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
            resource: { resource_type: "handoff", resource_id: "handoff-github-aux", resource_version: 1 },
            receipt: null,
            error: null,
          };
        },
        resolveTarget: async () => ({
          spec_version: "1.0",
          request_message_id: "message-resolve",
          operation_status: "accepted",
          resource: { resource_type: "handoff", resource_id: "handoff-github-aux", resource_version: 2 },
          receipt: null,
          error: null,
        }),
        getHandoff: async () => { throw new Error("not used"); },
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
            handoff_id: "handoff-github-aux",
            thread_id: payload.thread_id,
            stream_version: 2,
            role: {
              role_id: "github-provider",
              version: 1,
              display_name: "GitHub Provider",
              description: "typed read-only capability provider",
              capability_ids: [candidate.capability_id],
            },
            capability_id: candidate.capability_id,
            source_reference: { uri: "urn:test:github-capability-source", extensions: {} },
            initiator: { actor_id: originalResponsibleActor, actor_type: "agent" },
            agent_private_context: null,
            intent: payload.intent,
            context_reference: null,
            resolved_context: null,
            authority_scope: payload.authority_scope,
            acceptance_criteria: [],
            priority: "normal",
            accept_by: payload.accept_by,
            result_due_at: payload.result_due_at,
            workspace_path: "/tmp/github-provider",
          }, async () => undefined, new AbortController().signal);
          return result.summary[0]!.data as {
            outcome: "succeeded";
            data: RuntimeJsonObject;
            artifacts: readonly RuntimeJsonObject[];
          };
        },
      },
      state: new MemoryAgentRuntimeStateStore(),
      now: () => "2026-08-02T10:00:00.000Z",
    });

    const discovered = await invocationPort.discover({
      capability_id: "github.pull_request.list",
      version_constraint: "1.0.0",
    });
    expect(discovered).toEqual([candidate]);

    const result = await invocationPort.invoke({
      invocation_id: "invocation-github-1",
      original_handoff_id: "handoff-original",
      thread_id: "thread-1",
      capability_id: "github.pull_request.list",
      version_constraint: "1.0.0",
      input: { target: { owner: "AgentEra" }, state: "open", page_size: 30 },
      reason: "current pull request facts",
      deadline: "2026-08-02T10:01:00.000Z",
    }, new AbortController().signal);

    expect(discoveredCapability).toBe("github.pull_request.list");
    expect(result).toMatchObject({
      outcome: "succeeded",
      auxiliary_handoff_id: "handoff-github-aux",
      data: {
        state: "complete",
        items: [{ number: 1 }, { number: 2 }],
        evidence: { provider: "github", complete: true },
      },
    });
    expect((offered as { verifier?: unknown } | null)?.verifier).toEqual({
      actor_id: originalResponsibleActor,
      actor_type: "agent",
    });
    expect(JSON.stringify({ offered, result })).not.toMatch(/access_token|private_key|credential_ref/i);
  });
});
