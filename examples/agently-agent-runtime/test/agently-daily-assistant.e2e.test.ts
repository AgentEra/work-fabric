import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { workspacePath } from "@work-fabric/agent-runtime-host";
import type { AgentlyProcessDriverObservation } from "@work-fabric/adapter-agent-runtime-agently";

import {
  DAILY_E2E,
  dailyAssistantOffer,
  e2eClient,
  partitionId,
  provisionDailyAssistant,
  resourceId,
  runtimeRun,
  startDailyAssistantWorkFabric,
  startRealAgentlyRuntime,
} from "./daily-assistant-e2e-builders.js";
import { startFakeOpenAiCompatibleServer } from "./fake-openai-compatible-server.js";
import { NeutralE2eFixture, eventually } from "./e2e-support.js";

async function filesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesBelow(path);
    return entry.isFile() ? [path] : [];
  }))).flat();
}

const validAssistantOutput = Object.freeze({
  request_summary: "创建一个新需求",
  response: "需求已整理，建议交给需求分析角色确认",
  missing_information: ["期望上线日期"],
  handoff_draft_required: true,
  handoff_draft_reason: "需要专业需求分析",
  handoff_draft_capability: "requirements.analysis",
  handoff_draft_intent: "梳理需求范围并确认验收标准",
  handoff_draft_acceptance_criteria: ["范围得到业务方确认"],
});

/**
 * These are intentionally development-only fixture values.  The assertion is
 * made against every externally observable/public and durable surface the E2E
 * owns, so the fake model's bounded metadata cannot mask a credential leak.
 */
const fixtureSecrets = Object.freeze([
  DAILY_E2E.runtimeToken,
  DAILY_E2E.modelToken,
  DAILY_E2E.adminToken,
  DAILY_E2E.humanToken,
]);

function assertNoFixtureSecrets(...surfaces: readonly unknown[]): void {
  for (const surface of surfaces) {
    const text = typeof surface === "string" ? surface : JSON.stringify(surface);
    for (const secret of fixtureSecrets) expect(text).not.toContain(secret);
  }
}

describe("Daily Assistant real boundaries", () => {
  it("completes and recovers the Daily Assistant Handoff through real boundaries", async () => {
    const fixture = await NeutralE2eFixture.create("work-fabric-daily-e2e-");
    const { directory } = fixture;
    let model: Awaited<ReturnType<typeof startFakeOpenAiCompatibleServer>> | undefined;
    let service: Awaited<ReturnType<typeof startDailyAssistantWorkFabric>> | undefined;
    let runtime: Awaited<ReturnType<typeof startRealAgentlyRuntime>> | undefined;
    const workerObservations: AgentlyProcessDriverObservation[] = [];
    try {
      model = await startFakeOpenAiCompatibleServer({ structuredOutput: {
        request_summary: "创建一个新需求", response: "需求已整理，建议交给需求分析角色确认", missing_information: ["期望上线日期"],
        handoff_draft_required: true, handoff_draft_reason: "需要专业需求分析", handoff_draft_capability: "requirements.analysis",
        handoff_draft_intent: "梳理需求范围并确认验收标准", handoff_draft_acceptance_criteria: ["范围得到业务方确认"],
      } });
      fixture.register(() => model!.close());
      service = await startDailyAssistantWorkFabric({ directory });
      if (service === undefined || model === undefined) throw new Error("E2E resources did not start");
      const startedService = service;
      const startedModel = model;
      fixture.register(() => startedService.service.close());
      await provisionDailyAssistant(startedService.origin);
      runtime = await startRealAgentlyRuntime({ baseUrl: startedService.origin, modelBaseUrl: startedModel.baseUrl, directory, onWorkerObservation: (observation) => workerObservations.push(observation) });
      if (runtime === undefined) throw new Error("runtime did not start");
      const firstRuntime = runtime;
      fixture.register(() => firstRuntime.close());
      const offered = await startedService.human.handoffs.offer(dailyAssistantOffer(), { idempotencyKey: "daily-assistant-e2e-offer-1" });
      const handoffId = resourceId(offered);
      const initialEvents = await startedService.human.queries.listHandoffEvents(handoffId);
      expect(initialEvents).toHaveLength(1);
      await eventually(async () => expect(
        await startedService.runtime.endpoints.listInboxPartitions(DAILY_E2E.runtimeEndpointId),
      ).toMatchObject({ items: [{ partition_id: partitionId(handoffId) }] }));
      await expect(
        startedService.runtime.subscriptions.get(DAILY_E2E.subscriptionId),
      ).resolves.toMatchObject({ endpoint_id: DAILY_E2E.runtimeEndpointId, delivery: { mode: "sse" } });
      await expect(
        startedService.runtime.queries.getHandoff(handoffId),
      ).resolves.toMatchObject({ state: { lifecycle_state: "offered" } });
      await eventually(async () => expect(await runtimeRun(firstRuntime.statePath, handoffId)).not.toBeNull(), 7_000);
      await eventually(async () => expect(startedModel.requests).toHaveLength(1), 7_000);
      await eventually(async () => {
        const handoff = await startedService.human.queries.getHandoff(handoffId);
        expect(handoff.state.lifecycle_state).toBe("result_returned");
        const result = handoff.state.result;
        if (result === null || typeof result !== "object" || Array.isArray(result)) throw new Error("expected Handoff result");
        const extensions = (result as Record<string, unknown>).extensions;
        if (extensions === null || typeof extensions !== "object" || Array.isArray(extensions)) throw new Error("expected result extensions");
        expect((extensions as Record<string, unknown>)["workfabric.agent/assistant_output"]).toMatchObject({ handoff_draft_required: true });
      });
      await runtime.close();
      runtime = await startRealAgentlyRuntime({ baseUrl: startedService.origin, modelBaseUrl: startedModel.baseUrl, directory, onWorkerObservation: (observation) => workerObservations.push(observation) });
      const restartedRuntime = runtime;
      fixture.register(() => restartedRuntime.close());
      expect(startedModel.requests).toHaveLength(1);
      const second = await startedService.human.handoffs.offer(dailyAssistantOffer(), { idempotencyKey: "daily-assistant-e2e-offer-2" });
      const secondHandoffId = resourceId(second);
      await eventually(async () => {
        expect((await startedService.human.queries.getHandoff(secondHandoffId)).state.lifecycle_state).toBe("result_returned");
      });
      expect(startedModel.requests).toHaveLength(2);

      // The Host resolves an opaque, tenant-separated workspace per Handoff.
      // Neither raw identifier can become a path segment, and one Handoff's
      // workspace cannot be reused by another Handoff or another tenant.
      const firstWorkspace = workspacePath(firstRuntime.workspaceRoot, DAILY_E2E.tenantId, handoffId);
      const secondWorkspace = workspacePath(firstRuntime.workspaceRoot, DAILY_E2E.tenantId, secondHandoffId);
      const otherTenantWorkspace = workspacePath(firstRuntime.workspaceRoot, "tenant-daily-e2e-other", handoffId);
      expect(firstWorkspace).not.toBe(secondWorkspace);
      expect(firstWorkspace).not.toBe(otherTenantWorkspace);
      expect(firstWorkspace).not.toContain(handoffId);
      expect(secondWorkspace).not.toContain(secondHandoffId);
      expect(otherTenantWorkspace).not.toContain(DAILY_E2E.tenantId);
      const firstWorkspaceFiles = await filesBelow(firstWorkspace);
      const secondWorkspaceFiles = await filesBelow(secondWorkspace);
      for (const path of firstWorkspaceFiles) expect(path).not.toContain(secondHandoffId);
      for (const path of secondWorkspaceFiles) expect(path).not.toContain(handoffId);
      const [firstWorkspaceContents, secondWorkspaceContents] = await Promise.all([
        Promise.all(firstWorkspaceFiles.map((path) => readFile(path, "utf8"))),
        Promise.all(secondWorkspaceFiles.map((path) => readFile(path, "utf8"))),
      ]);
      for (const content of firstWorkspaceContents) expect(content).not.toContain(secondHandoffId);
      for (const content of secondWorkspaceContents) expect(content).not.toContain(handoffId);

      const durableSurfaces = await Promise.all(
        (await filesBelow(directory)).map(async (path) => readFile(path, "utf8")),
      );
      const completedEvents = await startedService.human.queries.listHandoffEvents(handoffId);
      expect(completedEvents.length).toBeGreaterThanOrEqual(4);
      const completed = await startedService.human.queries.getHandoff(handoffId);
      expect(completed.state.child_handoff_id).toBeNull();
      // Service/runtime SQLite rows and workspace bytes, public Status/Result
      // snapshots and Events, and the fake model's bounded metadata are all
      // credential-free.  The test never captures raw request bodies or logs.
      assertNoFixtureSecrets(
        durableSurfaces,
        completed,
        completedEvents,
        startedModel.requests,
      );
      expect(workerObservations).toHaveLength(2);
      for (const observation of workerObservations) {
        expect(observation.task_json).toContain('"handoff_id"');
        assertNoFixtureSecrets(
          observation.task_json,
          observation.stdout,
          observation.stderr,
          observation.runtime_log,
        );
      }
      // Scan each public command surface separately. A combined Handoff
      // snapshot must not hide a credential leak in either payload.
      assertNoFixtureSecrets(completed.latest_status, completed.state.result);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it("keeps an ungranted Runtime outside the Handoff and model boundary", async () => {
    const fixture = await NeutralE2eFixture.create("work-fabric-daily-deny-");
    let model: Awaited<ReturnType<typeof startFakeOpenAiCompatibleServer>> | undefined;
    let service: Awaited<ReturnType<typeof startDailyAssistantWorkFabric>> | undefined;
    try {
      model = await startFakeOpenAiCompatibleServer({ structuredOutput: validAssistantOutput });
      fixture.register(() => model!.close());
      service = await startDailyAssistantWorkFabric({ directory: fixture.directory, runtimeAuthority: false });
      fixture.register(() => service!.service.close());
      await provisionDailyAssistant(service.origin);
      const offered = await service.human.handoffs.offer(dailyAssistantOffer(), { idempotencyKey: "daily-assistant-no-grant" });
      await expect(startRealAgentlyRuntime({ baseUrl: service.origin, modelBaseUrl: model.baseUrl, directory: fixture.directory }))
        .rejects.toThrow();
      expect(model.requests).toHaveLength(0);
      await expect(service.human.queries.getHandoff(resourceId(offered)))
        .resolves.toMatchObject({ state: { lifecycle_state: "offered" } });
    } finally {
      await fixture.close();
    }
  }, 20_000);

  it("does not let the Daily Assistant read or execute a Handoff for another Actor", async () => {
    const fixture = await NeutralE2eFixture.create("work-fabric-daily-wrong-target-");
    let model: Awaited<ReturnType<typeof startFakeOpenAiCompatibleServer>> | undefined;
    let service: Awaited<ReturnType<typeof startDailyAssistantWorkFabric>> | undefined;
    let runtime: Awaited<ReturnType<typeof startRealAgentlyRuntime>> | undefined;
    try {
      model = await startFakeOpenAiCompatibleServer({ structuredOutput: validAssistantOutput });
      fixture.register(() => model!.close());
      service = await startDailyAssistantWorkFabric({ directory: fixture.directory });
      fixture.register(() => service!.service.close());
      await provisionDailyAssistant(service.origin);
      runtime = await startRealAgentlyRuntime({ baseUrl: service.origin, modelBaseUrl: model.baseUrl, directory: fixture.directory });
      fixture.register(() => runtime!.close());
      const offered = await service.human.handoffs.offer(dailyAssistantOffer({ actor_id: "actor-other-agent" }), { idempotencyKey: "daily-assistant-wrong-target" });
      const handoffId = resourceId(offered);
      await expect(service.runtime.queries.getHandoff(handoffId)).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(model.requests).toHaveLength(0);
      expect(await runtimeRun(runtime.statePath, handoffId)).toBeNull();
    } finally {
      await fixture.close();
    }
  }, 20_000);

  it("contains malformed worker output as a failed local run without a Result", async () => {
    const fixture = await NeutralE2eFixture.create("work-fabric-daily-malformed-");
    let model: Awaited<ReturnType<typeof startFakeOpenAiCompatibleServer>> | undefined;
    let service: Awaited<ReturnType<typeof startDailyAssistantWorkFabric>> | undefined;
    let runtime: Awaited<ReturnType<typeof startRealAgentlyRuntime>> | undefined;
    try {
      model = await startFakeOpenAiCompatibleServer({ structuredOutput: { response: "missing required output fields" } });
      fixture.register(() => model!.close());
      service = await startDailyAssistantWorkFabric({ directory: fixture.directory });
      fixture.register(() => service!.service.close());
      await provisionDailyAssistant(service.origin);
      runtime = await startRealAgentlyRuntime({ baseUrl: service.origin, modelBaseUrl: model.baseUrl, directory: fixture.directory });
      fixture.register(() => runtime!.close());
      const handoffId = resourceId(await service.human.handoffs.offer(dailyAssistantOffer(), { idempotencyKey: "daily-assistant-malformed" }));
      await eventually(async () => expect((await runtimeRun(runtime!.statePath, handoffId))?.state).toBe("failed"), 10_000);
      const handoff = await service.human.queries.getHandoff(handoffId);
      expect(handoff.state.lifecycle_state).toBe("accepted");
      expect(handoff.state.result).toBeNull();
      // The configured model client may safely retry a malformed response;
      // the Fabric-visible invariant is that no Result is ever published.
      expect(model.requests.length).toBeGreaterThanOrEqual(1);
    } finally {
      await fixture.close();
    }
  }, 20_000);

  it("fails a timed-out Worker without publishing a Result", async () => {
    const fixture = await NeutralE2eFixture.create("work-fabric-daily-stop-");
    let model: Awaited<ReturnType<typeof startFakeOpenAiCompatibleServer>> | undefined;
    let service: Awaited<ReturnType<typeof startDailyAssistantWorkFabric>> | undefined;
    let runtime: Awaited<ReturnType<typeof startRealAgentlyRuntime>> | undefined;
    try {
      model = await startFakeOpenAiCompatibleServer({ structuredOutput: validAssistantOutput, delayMs: 3_000 });
      fixture.register(() => model!.close());
      service = await startDailyAssistantWorkFabric({ directory: fixture.directory });
      fixture.register(() => service!.service.close());
      await provisionDailyAssistant(service.origin);
      runtime = await startRealAgentlyRuntime({ baseUrl: service.origin, modelBaseUrl: model.baseUrl, directory: fixture.directory, timeoutSeconds: 1 });
      fixture.register(() => runtime!.close());
      const timeoutId = resourceId(await service.human.handoffs.offer(dailyAssistantOffer(), { idempotencyKey: "daily-assistant-timeout" }));
      await eventually(async () => expect((await runtimeRun(runtime!.statePath, timeoutId))?.state).toBe("failed"), 10_000);
      await eventually(async () => expect(model!.abortedResponses).toBeGreaterThanOrEqual(1), 5_000);
      expect((await service.human.queries.getHandoff(timeoutId)).state.result).toBeNull();

    } finally {
      await fixture.close();
    }
  }, 20_000);

  it("drains an active cancellation through public boundaries without a Result or child Handoff", async () => {
    const fixture = await NeutralE2eFixture.create("work-fabric-daily-cancel-");
    let model: Awaited<ReturnType<typeof startFakeOpenAiCompatibleServer>> | undefined;
    let service: Awaited<ReturnType<typeof startDailyAssistantWorkFabric>> | undefined;
    let runtime: Awaited<ReturnType<typeof startRealAgentlyRuntime>> | undefined;
    try {
      model = await startFakeOpenAiCompatibleServer({ structuredOutput: validAssistantOutput, delayMs: 5_000 });
      fixture.register(() => model!.close());
      service = await startDailyAssistantWorkFabric({ directory: fixture.directory });
      fixture.register(() => service!.service.close());
      await provisionDailyAssistant(service.origin);
      runtime = await startRealAgentlyRuntime({ baseUrl: service.origin, modelBaseUrl: model.baseUrl, directory: fixture.directory });
      fixture.register(() => runtime!.close());
      const handoffId = resourceId(await service.human.handoffs.offer(dailyAssistantOffer(), { idempotencyKey: "daily-assistant-cancel" }));
      await eventually(async () => expect(model!.requests.length).toBeGreaterThanOrEqual(1), 10_000);
      const accepted = await service.human.queries.getHandoff(handoffId);
      await service.human.handoffs.cancel(
        { handoff_id: handoffId, reason: [{ kind: "text", media_type: "text/plain", text: "request withdrawn" }] },
        { expectedVersion: accepted.stream_version, idempotencyKey: "daily-assistant-cancel-command" },
      );

      await eventually(async () => expect((await runtimeRun(runtime!.statePath, handoffId))?.state).toBe("cancelled"), 10_000);
      await eventually(async () => expect(model!.abortedResponses).toBeGreaterThanOrEqual(1), 5_000);
      const cancelled = await service.human.queries.getHandoff(handoffId);
      expect(cancelled.state).toMatchObject({ lifecycle_state: "cancelled", result: null });
      const events = await service.human.queries.listHandoffEvents(handoffId);
      expect(events.map((event) => event.type)).not.toContain("workfabric.handoff.result_returned.v1");
      expect(events.map((event) => event.type)).not.toContain("workfabric.handoff.transferred.v1");
    } finally {
      await fixture.close();
    }
  }, 30_000);

});
