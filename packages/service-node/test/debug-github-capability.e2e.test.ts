import { createServer } from "node:net";

import { describe, expect, it } from "vitest";

import { CatalogCapabilityDisclosure } from "@work-fabric/agent-capability-runtime";
import type {
  GitHubApiPullRequestListInput,
  GitHubPullRequestRecord,
  GitHubReadApi,
} from "@work-fabric/provider-github";
import { GitHubCapabilitySchemaRegistry } from "@work-fabric/provider-github";

import {
  DAILY_E2E,
  e2eClient,
  provisionDailyAssistant,
  provisionGitHubReadProvider,
  runtimeRun,
  startDailyAssistantWorkFabric,
  startGitHubReadProviderFixture,
  startRealAgentlyRuntime,
} from "../../../examples/agently-agent-runtime/test/daily-assistant-e2e-builders.js";
import { NeutralE2eFixture } from "../../../examples/agently-agent-runtime/test/e2e-support.js";
import { startFakeOpenAiCompatibleServer } from "../../../examples/agently-agent-runtime/test/fake-openai-compatible-server.js";

const markdown = [
  "当前有 2 个未关闭 PR：",
  "- [#42 修复 SSE 重连](https://github.com/AgentEra/work-fabric/pull/42)",
  "- [#43 增加 GitHub Provider](https://github.com/AgentEra/work-fabric/pull/43)",
].join("\n");

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function request(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${DAILY_E2E.humanToken}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
  });
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(JSON.stringify(body));
  return body;
}

function fakeGitHubApi() {
  const calls: Array<{
    capability_id: "github.pull_request.list";
    owner: string;
    state: string | undefined;
  }> = [];
  const unused = async (): Promise<never> => {
    throw new Error("unexpected GitHub API call");
  };
  const repository = { owner: "AgentEra", name: "work-fabric" } as const;
  const items: readonly GitHubPullRequestRecord[] = [
    {
      repository,
      number: 42,
      title: "修复 SSE 重连",
      url: "https://github.com/AgentEra/work-fabric/pull/42",
      author: "octocat",
      draft: false,
      base_branch: "main",
      head_branch: "fix/sse-reconnect",
      assignees: [],
      requested_reviewers: [],
      labels: [],
      mergeable: true,
      created_at: "2026-08-03T08:00:00.000Z",
      updated_at: "2026-08-03T09:00:00.000Z",
    },
    {
      repository,
      number: 43,
      title: "增加 GitHub Provider",
      url: "https://github.com/AgentEra/work-fabric/pull/43",
      author: "octocat",
      draft: false,
      base_branch: "main",
      head_branch: "feat/github-provider",
      assignees: [],
      requested_reviewers: [],
      labels: [],
      mergeable: true,
      created_at: "2026-08-03T08:30:00.000Z",
      updated_at: "2026-08-03T09:30:00.000Z",
    },
  ];
  const api: GitHubReadApi = {
    getIdentity: unused,
    listRepositories: unused,
    getRepository: unused,
    listPullRequests: unused,
    searchPullRequests: async (input: GitHubApiPullRequestListInput) => {
      const owner = "owner" in input.target
        ? input.target.owner
        : "repositories" in input.target
          ? input.target.repositories[0]?.owner
          : undefined;
      if (owner === undefined) throw new Error("expected owner target");
      calls.push({
        capability_id: "github.pull_request.list",
        owner,
        state: input.state,
      });
      return { items };
    },
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
  return { api, calls };
}

describe("Debug Channel GitHub capability collaboration", () => {
  it("returns Agent-authored Markdown grounded only in the current GitHub Result", async () => {
    const fixture = await NeutralE2eFixture.create("work-fabric-debug-github-e2e-");
    const port = await freePort();
    const ignoredPrivateState = {
      namespace: "daily-assistant.scheduling/v1",
      expected_version: 0,
      phase: "cancelled",
      proposal: {
        version: 1,
        title: "unused",
        participant_resource_uris: [],
        start_at: "2026-08-03T00:00:00.000Z",
        end_at: "2026-08-03T00:01:00.000Z",
        timezone: "UTC",
        summary_markdown: "unused",
      },
      confirmed_proposal_digest: "unused",
      confirmation_handoff_id: "unused",
      calendar_result_uri: "unused",
      capability_result_handoff_ids: [],
    };
    const modelOutputs = [
      {
        turn_type: "capability_request",
        request_summary: "查询当前未关闭的 PR",
        context_status: "needs_context",
        context_basis: "需要当前 GitHub PR 事实",
        missing_facts: ["当前未关闭的 PR"],
        response: "",
        invocation_id: "github-pr-list-1",
        capability_id: "github.pull_request.list",
        version_constraint: "1.0.0",
        input: {
          target: { owner: "AgentEra" },
          state: "open",
          page_size: 30,
        },
        reason: "需要当前 GitHub PR 事实",
        private_state_action: "none",
        private_state: ignoredPrivateState,
      },
      {
        turn_type: "final",
        request_summary: "汇总当前未关闭的 PR",
        context_status: "sufficient",
        context_basis: "当前调用返回了完整 GitHub PR 列表",
        missing_facts: [],
        response: markdown,
        invocation_id: "",
        capability_id: "",
        version_constraint: "",
        input: {},
        reason: "",
        private_state_action: "none",
        private_state: ignoredPrivateState,
      },
    ] as const;
    const model = await startFakeOpenAiCompatibleServer({
      structuredOutput: {},
      structuredOutputs: modelOutputs,
    });
    fixture.register(() => model.close());
    const service = await startDailyAssistantWorkFabric({
      directory: fixture.directory,
      composition: {
        configuration_revision: "e2e:debug-github-capability",
        plugins: {
          "debug-local": {
            type: "collaboration-channel.debug",
            enabled: true,
            config: {
              connector_id: "debug-local",
              external_tenant_id: "debug-github-e2e",
              listen: { host: "127.0.0.1", port },
              credentials: { bearer_token: DAILY_E2E.humanToken },
              intake_target: {
                actor_id: DAILY_E2E.runtimeActorId,
                endpoint_id: DAILY_E2E.runtimeEndpointId,
              },
              participants: {
                "internal-user": {
                  mode: "static",
                  external_subject_type: "human",
                  external_subject_id: "debug-human",
                  actor_id: DAILY_E2E.humanActorId,
                  actor_type: "human",
                  endpoint_id: DAILY_E2E.humanEndpointId,
                },
              },
              delegation: {
                scopes: ["work:read", "result:write", "github:read"],
                may_redelegate: true,
              },
              accept_within_seconds: 1_800,
              result_due_within_seconds: 3_600,
              limits: {
                max_request_bytes: 262_144,
                max_content_parts: 32,
                max_text_bytes: 131_072,
                max_json_depth: 32,
                max_page_size: 100,
              },
              retention: { max_age_days: 14, cleanup_batch_size: 500 },
              worker: {
                poll_interval_ms: 10,
                lease_seconds: 30,
                batch_limit: 10,
                max_attempts: 3,
              },
            },
          },
        },
      },
    });
    fixture.register(() => service.service.close());
    await provisionDailyAssistant(service.origin);
    await provisionGitHubReadProvider(service.origin);
    const fakeGitHub = fakeGitHubApi();
    const provider = await startGitHubReadProviderFixture({
      baseUrl: service.origin,
      directory: fixture.directory,
      api: fakeGitHub.api,
    });
    fixture.register(() => provider.close());
    const disclosed = await new CatalogCapabilityDisclosure(
      e2eClient(
        service.origin,
        DAILY_E2E.runtimeToken,
        DAILY_E2E.runtimeActorId,
        DAILY_E2E.runtimeEndpointId,
      ).citizens,
      new GitHubCapabilitySchemaRegistry(),
    ).list(["github."], new AbortController().signal);
    expect(disclosed).toHaveLength(12);
    expect(disclosed.every((item) => item.operation_kind === "query")).toBe(true);
    const workerObservations: unknown[] = [];
    const runtime = await startRealAgentlyRuntime({
      baseUrl: service.origin,
      modelBaseUrl: model.baseUrl,
      directory: fixture.directory,
      capabilityNamespaces: ["github."],
      onWorkerObservation: (observation) => workerObservations.push(observation),
    });
    fixture.register(() => runtime.close());

    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const submitted = await request(
        baseUrl,
        "/v1/conversations/conversation-github/messages",
        {
          method: "POST",
          body: JSON.stringify({
            idempotency_key: "debug-github-message-1",
            participant_ref: "internal-user",
            content: [{
              kind: "text",
              media_type: "text/markdown",
              text: "查询 AgentEra 当前未关闭的 PR，并整理成飞书可直接发送的 Markdown。",
            }],
          }),
        },
      );
      const submissionId = String(submitted.submission_id);
      const deadline = Date.now() + 15_000;
      let events: Record<string, unknown> = { items: [] };
      while (Date.now() < deadline) {
        events = await request(
          baseUrl,
          "/v1/conversations/conversation-github/events?limit=10",
        );
        if (Array.isArray(events.items) && events.items.length === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!Array.isArray(events.items) || events.items.length !== 1) {
        const status = await request(
          baseUrl,
          `/v1/submissions/${encodeURIComponent(submissionId)}`,
        );
        const handoff = status.handoff as Record<string, unknown> | undefined;
        const run = typeof handoff?.handoff_id === "string"
          ? await runtimeRun(runtime.statePath, handoff.handoff_id)
          : null;
        const handoffEvents = typeof handoff?.handoff_id === "string"
          ? await service.human.queries.listHandoffEvents(handoff.handoff_id)
          : [];
        const handoffSnapshot = typeof handoff?.handoff_id === "string"
          ? await service.human.queries.getHandoff(handoff.handoff_id)
          : null;
        throw new Error(JSON.stringify({
          status,
          run,
          handoffEvents,
          handoffSnapshot,
          workerObservations,
          events,
          model: model.requests,
        }));
      }

      expect(events).toMatchObject({
        items: [{
          event: { type: "workfabric.handoff.result_returned.v1" },
          handoff_snapshot: {
            lifecycle_state: "result_returned",
            result: {
              summary: [{
                kind: "text",
                media_type: "text/markdown",
                text: markdown,
              }],
            },
          },
        }],
      });
      expect(fakeGitHub.calls).toEqual([{
        capability_id: "github.pull_request.list",
        owner: "AgentEra",
        state: "open",
      }]);
      expect(model.requests).toHaveLength(2);
      expect(JSON.stringify(events)).not.toMatch(
        /private_key|access_token|github_pat_/i,
      );
    } finally {
      await fixture.close();
    }
  }, 40_000);
});
