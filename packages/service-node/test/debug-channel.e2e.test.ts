import { createServer } from "node:net";

import { describe, expect, it } from "vitest";

import {
  DAILY_E2E,
  provisionDailyAssistant,
  startDailyAssistantWorkFabric,
  startRealAgentlyRuntime,
} from "../../../examples/agently-agent-runtime/test/daily-assistant-e2e-builders.js";
import { NeutralE2eFixture } from "../../../examples/agently-agent-runtime/test/e2e-support.js";
import { startFakeOpenAiCompatibleServer } from "../../../examples/agently-agent-runtime/test/fake-openai-compatible-server.js";

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

describe("Debug Channel complete collaboration", () => {
  it("moves Markdown and typed data through a real Agent and captures its semantic Result", async () => {
    const fixture = await NeutralE2eFixture.create("work-fabric-debug-e2e-");
    const port = await freePort();
    const model = await startFakeOpenAiCompatibleServer({
      structuredOutput: {
        request_summary: "总结 EDA 信息",
        response: "已完成 EDA 摘要：[查看资料](https://example.com/eda)",
        missing_information: [],
        handoff_draft_required: false,
        handoff_draft_reason: "当前请求可直接完成，无需继续交接",
        handoff_draft_capability: "",
        handoff_draft_intent: "",
        handoff_draft_acceptance_criteria: [],
      },
    });
    fixture.register(() => model.close());
    const service = await startDailyAssistantWorkFabric({
      directory: fixture.directory,
      composition: {
        configuration_revision: "e2e:debug-channel",
        plugins: {
          "debug-local": {
            type: "collaboration-channel.debug",
            enabled: true,
            config: {
              connector_id: "debug-local",
              external_tenant_id: "debug-e2e",
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
                scopes: ["work:read", "result:write"],
                may_redelegate: false,
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
              retention: {
                max_age_days: 14,
                cleanup_batch_size: 500,
              },
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
    const runtime = await startRealAgentlyRuntime({
      baseUrl: service.origin,
      modelBaseUrl: model.baseUrl,
      directory: fixture.directory,
    });
    fixture.register(() => runtime.close());
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const submitted = await request(
        baseUrl,
        "/v1/conversations/conversation-eda/messages",
        {
          method: "POST",
          body: JSON.stringify({
            idempotency_key: "debug-e2e-message-1",
            participant_ref: "internal-user",
            content: [
              {
                kind: "text",
                media_type: "text/markdown",
                text: "请总结 **EDA** 信息。",
              },
              {
                kind: "data",
                schema_ref: "https://schemas.example.com/eda/v1",
                data: { source: "local-debug", status: "draft" },
              },
            ],
          }),
        },
      );
      expect(submitted).toMatchObject({
        submission_id: expect.any(String),
        ingress_state: "pending",
      });
      const submissionId = String(submitted.submission_id);
      const deadline = Date.now() + 12_000;
      let events: Record<string, unknown> = { items: [] };
      while (Date.now() < deadline) {
        events = await request(
          baseUrl,
          "/v1/conversations/conversation-eda/events?limit=10",
        );
        if (
          Array.isArray(events.items)
          && events.items.length === 1
        ) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!Array.isArray(events.items) || events.items.length !== 1) {
        const status = await request(
          baseUrl,
          `/v1/submissions/${encodeURIComponent(submissionId)}`,
        );
        throw new Error(JSON.stringify({
          status,
          model_requests: model.requests,
          events,
        }));
      }
      expect(events).toMatchObject({
        items: [{
          event: { type: "workfabric.handoff.result_returned.v1" },
          handoff_snapshot: {
            lifecycle_state: "result_returned",
            result: {
              summary: [{
                text: "已完成 EDA 摘要：[查看资料](https://example.com/eda)",
              }],
            },
          },
        }],
      });
      const replay = await request(
        baseUrl,
        "/v1/conversations/conversation-eda/messages",
        {
          method: "POST",
          body: JSON.stringify({
            idempotency_key: "debug-e2e-message-1",
            participant_ref: "internal-user",
            content: [
              {
                kind: "text",
                media_type: "text/markdown",
                text: "请总结 **EDA** 信息。",
              },
              {
                kind: "data",
                schema_ref: "https://schemas.example.com/eda/v1",
                data: { source: "local-debug", status: "draft" },
              },
            ],
          }),
        },
      );
      expect(replay.submission_id).toBe(submissionId);
      expect(model.requests).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  }, 30_000);
});
