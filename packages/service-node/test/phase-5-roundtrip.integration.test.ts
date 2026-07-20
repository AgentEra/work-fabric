import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import type { LocalAuthorityAllowRule } from "@work-fabric/adapter-identity-local";
import type { IdGenerator } from "@work-fabric/exchange-core";
import {
  BearerTokenProvider,
  WorkFabricClient,
  type HandoffOfferPayload,
} from "@work-fabric/sdk-typescript";
import { addUtcTimestampSeconds } from "@work-fabric/exchange-spi";

import { composeNodeService, parseServiceConfig } from "../src/index.js";

const tenant = "tenant-phase5";
const exchange = "exchange-phase5";
const handoffId = "handoff_phase5_1";

function partitionId(): string {
  const material = JSON.stringify({ root_handoff_id: handoffId, tenant_id: tenant });
  return `partition:${createHash("sha256").update(material).digest("hex")}`;
}

function recoveryId(key: string): string {
  return `recovery_${createHash("sha256").update(JSON.stringify([tenant, key])).digest("base64url")}`;
}

function rule(
  principalId: string,
  actorId: string,
  actorType: "human" | "agent",
  endpointId: string,
  action: string,
  resourceId: string | null,
): LocalAuthorityAllowRule {
  return {
    tenant_id: tenant, principal_id: principalId, actor_id: actorId,
    actor_type: actorType, endpoint_id: endpointId, action, resource_id: resourceId,
  };
}

function client(origin: string, token: string, actorId: string, endpointId: string) {
  return new WorkFabricClient({
    baseUrl: origin, tenantId: tenant, exchangeId: exchange,
    representation: { actorId, endpointId },
    authentication: new BearerTokenProvider(token),
  });
}

function offer(clock: { now(): string }): HandoffOfferPayload {
  const acceptBy = addUtcTimestampSeconds(clock.now(), 300);
  const resultDueAt = addUtcTimestampSeconds(clock.now(), 3_600);
  return {
    thread_id: "thread-customer-project-1",
    work_reference: { uri: "feishu://document/customer-project-1", extensions: {} },
    target: { actor_id: "actor-agent" },
    intent: [{ kind: "text", media_type: "text/plain", text: "Implement in the external runtime" }],
    authority_scope: {
      delegation_id: "delegation-phase5", scopes: ["work:read", "result:write"],
      resource_refs: ["feishu://document/customer-project-1"],
      expires_at: resultDueAt, may_redelegate: false,
    },
    acceptance_criteria: [{
      criterion_id: "tests-pass", description: "Tests pass", required: true,
      result_schema_ref: null, required_evidence_types: ["test_report"],
    }],
    verifier: { actor_id: "actor-human", actor_type: "human" },
    priority: "normal",
    accept_by: acceptBy,
    result_due_at: resultDueAt,
  };
}

describe("Phase 5 public HTTP/SDK roundtrip", () => {
  it("projects, rebuilds, audits and fences recovery without executing participant work", async () => {
    const clock = { now: () => "2026-07-20T00:00:00.000Z" };
    const partition = partitionId();
    const acceptedRecovery = recoveryId("projection-rebuild-1");
    const deniedRecovery = recoveryId("projection-rebuild-denied");
    const authorityRules = [
      rule("principal-human", "actor-human", "human", "endpoint-human", "workfabric.handoff.offer.v1", null),
      rule("principal-agent", "actor-agent", "agent", "endpoint-agent", "workfabric.handoff.accept.v1", handoffId),
      rule("principal-agent", "actor-agent", "agent", "endpoint-agent", "workfabric.handoff.report_status.v1", handoffId),
      rule("principal-agent", "actor-agent", "agent", "endpoint-agent", "workfabric.handoff.return_result.v1", handoffId),
      rule("principal-human", "actor-human", "human", "endpoint-human", "workfabric.handoff.verify.v1", handoffId),
      rule("principal-human", "actor-human", "human", "endpoint-human", "workfabric.query.responsibility.list.v1", partition),
      rule("principal-human", "actor-human", "human", "endpoint-human", "workfabric.query.timeline.list.v1", partition),
      rule("principal-human", "actor-human", "human", "endpoint-human", "workfabric.query.relationship.list.v1", partition),
      rule("principal-human", "actor-human", "human", "endpoint-human", "workfabric.operations.projection.read.v1", partition),
      rule("principal-human", "actor-human", "human", "endpoint-human", "workfabric.operations.audit.read.v1", tenant),
      rule("principal-human", "actor-human", "human", "endpoint-human", "workfabric.operations.recovery.projection-rebuild.request.v1", partition),
      rule("principal-human", "actor-human", "human", "endpoint-human", "workfabric.operations.recovery.read.v1", acceptedRecovery),
      rule("principal-human", "actor-human", "human", "endpoint-human", "workfabric.operations.recovery.read.v1", deniedRecovery),
    ];
    let sequence = 0;
    const ids: IdGenerator = {
      nextId(kind) {
        sequence += 1;
        return kind === "handoff" ? handoffId : `${kind}_phase5_${sequence}`;
      },
    };
    const service = await composeNodeService(parseServiceConfig({
      storage_profile: "memory-demo", development_mode: true,
      tenant_id: tenant, exchange_id: exchange, cursor_secret: "phase5".repeat(8),
      identities: [
        { authentication_evidence: { bearer_token: "human-token" }, principal: {
          principal_id: "principal-human", tenant_id: tenant,
          actor_claims: [{ actor_id: "actor-human", actor_type: "human", endpoint_ids: ["endpoint-human"] }], attributes: {},
        } },
        { authentication_evidence: { bearer_token: "agent-token" }, principal: {
          principal_id: "principal-agent", tenant_id: tenant,
          actor_claims: [{ actor_id: "actor-agent", actor_type: "agent", endpoint_ids: ["endpoint-agent"] }], attributes: {},
        } },
      ],
      authority_rules: authorityRules,
      listen: { host: "127.0.0.1", port: 0 },
    }), { ids, clock });
    const { origin } = await service.listen();
    const human = client(origin, "human-token", "actor-human", "endpoint-human");
    const agent = client(origin, "agent-token", "actor-agent", "endpoint-agent");
    try {
      await expect(human.handoffs.offer(offer(clock), { idempotencyKey: "offer-1" }))
        .resolves.toMatchObject({ operation_status: "accepted", resource: { resource_id: handoffId, resource_version: 1 } });
      await expect(agent.handoffs.accept({ handoff_id: handoffId }, { expectedVersion: 1, idempotencyKey: "accept-1" }))
        .resolves.toMatchObject({ operation_status: "accepted", resource: { resource_version: 2 } });
      await expect(agent.handoffs.reportStatus({ handoff_id: handoffId, status: {
        status_report_id: "status-1", execution_status: "in_progress", progress: 0.5,
        message: [], observed_at: "2026-07-16T05:00:00.000Z", blocked_on: [],
      } }, { expectedVersion: 2, idempotencyKey: "status-1" }))
        .resolves.toMatchObject({ operation_status: "accepted", resource: { resource_version: 3 } });
      await expect(agent.handoffs.returnResult({ handoff_id: handoffId, result: {
        summary: [{ kind: "text", media_type: "text/plain", text: "External work complete" }],
        artifacts: [{ artifact_id: "artifact-1", artifact_type: "source_repository", resource: { uri: "urn:git:commit:abc", extensions: {} } }],
        evidence: [{ evidence_id: "evidence-1", evidence_type: "test_report", content: { kind: "resource", resource: { uri: "urn:test-report:1", media_type: "application/json", extensions: {} } } }],
      } }, { expectedVersion: 3, idempotencyKey: "result-1" }))
        .resolves.toMatchObject({ operation_status: "accepted", resource: { resource_version: 4 } });
      await expect(human.handoffs.verify({
        handoff_id: handoffId, satisfied_criterion_ids: ["tests-pass"],
        summary: [{ kind: "text", media_type: "text/plain", text: "Verified by the external human" }], evidence: [],
      }, { expectedVersion: 4, idempotencyKey: "verify-1" }))
        .resolves.toMatchObject({ operation_status: "accepted", resource: { resource_version: 5 } });

      await service.runProjection(partition, 100);
      const before = await Promise.all([
        human.collaboration.listResponsibilities({ partitionId: partition, limit: 20 }),
        human.collaboration.listTimeline({ partitionId: partition, handoffId, limit: 20 }),
        human.collaboration.listRelationships({ partitionId: partition, handoffId, limit: 20 }),
      ]);
      expect(before[0].items).toMatchObject([{ handoff_id: handoffId, lifecycle_state: "verified" }]);
      expect(before[1].items).toHaveLength(5);
      expect(before[2].items.length).toBeGreaterThan(0);

      await service.rebuildProjection(partition, 2);
      const after = await Promise.all([
        human.collaboration.listResponsibilities({ partitionId: partition, limit: 20 }),
        human.collaboration.listTimeline({ partitionId: partition, handoffId, limit: 20 }),
        human.collaboration.listRelationships({ partitionId: partition, handoffId, limit: 20 }),
      ]);
      expect(after.map((page) => page.items)).toEqual(before.map((page) => page.items));

      const status = await human.operations.getProjectionStatus({
        projectorId: "workfabric.collaboration.visibility.v1", partitionId: partition,
      });
      await expect(human.operations.requestRecovery({
        idempotencyKey: "projection-rebuild-1",
        target: { kind: "projection_rebuild", projector_id: "workfabric.collaboration.visibility.v1", partition_id: partition },
        expectedVersion: status.checkpoint_position, reason: "operator_requested",
      })).resolves.toMatchObject({ kind: "accepted" });
      await expect(agent.operations.requestRecovery({
        idempotencyKey: "projection-rebuild-denied",
        target: { kind: "projection_rebuild", projector_id: "workfabric.collaboration.visibility.v1", partition_id: partition },
        expectedVersion: status.checkpoint_position, reason: "operator_requested",
      })).rejects.toMatchObject({ status: 403 });
      await expect(human.operations.getRecovery(acceptedRecovery)).resolves.toMatchObject({ state: "pending" });
      await expect(human.operations.getRecovery(deniedRecovery)).rejects.toMatchObject({ status: 404 });

      const audit = await human.operations.listAudit({ limit: 100 });
      expect(audit.items.some((item) => item.operation.includes("recovery") && item.authorization_decision === "allowed")).toBe(true);
      expect(audit.items.some((item) => item.authorization_decision === "denied")).toBe(true);
      expect(JSON.stringify(audit)).not.toMatch(/human-token|agent-token|External work complete|feishu:\/\/document/);
    } finally {
      await service.close();
    }
  }, 15_000);
});
