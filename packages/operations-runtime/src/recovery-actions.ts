import type { ConnectorIngressStore } from "@work-fabric/connector-spi";
import type { ConnectorDiscrepancyStore } from "@work-fabric/connector-runtime";
import type { RecoveryRequestClaim } from "@work-fabric/operations-spi";
import type { RecoveryActionPort } from "./recovery-worker.js";

export interface RecoveryActionClock {
  now(): string;
}

export interface ProjectionRebuildOwner {
  currentVersion(tenantId: string, projectorId: string, partitionId: string): Promise<number>;
  rebuild(tenantId: string, projectorId: string, partitionId: string): Promise<void>;
}

export interface DeliveryReplayOwner {
  currentVersion(tenantId: string, subscriptionId: string, partitionId: string, eventId: string): Promise<number>;
  replay(tenantId: string, subscriptionId: string, partitionId: string, eventId: string): Promise<void>;
}

function version(actual: number, expected: number): void {
  if (actual !== expected) throw new Error("recovery target version conflict");
}

export class ConnectorRequeueRecoveryAction implements RecoveryActionPort {
  constructor(
    private readonly ingress: ConnectorIngressStore,
    private readonly clock: RecoveryActionClock,
  ) {}

  async execute(claim: RecoveryRequestClaim) {
    if (claim.target.kind !== "connector_requeue") {
      throw new TypeError("connector recovery target is invalid");
    }
    const record = await this.ingress.get({
      tenant_id: claim.tenant_id,
      connector_id: claim.target.connector_id,
      ingress_id: claim.target.ingress_id,
    });
    if (record === null) throw new Error("recovery target not found");
    version(record.attempt, claim.expected_version);
    await this.ingress.requeue({
      tenant_id: claim.tenant_id,
      connector_id: claim.target.connector_id,
      ingress_id: claim.target.ingress_id,
      now: this.clock.now(),
      available_at: claim.target.available_at,
      reason: claim.reason,
    });
    return { outcome_code: "connector_requeued" } as const;
  }
}

export class DiscrepancyAcknowledgeRecoveryAction implements RecoveryActionPort {
  constructor(
    private readonly discrepancies: ConnectorDiscrepancyStore,
    private readonly clock: RecoveryActionClock,
  ) {}

  async execute(claim: RecoveryRequestClaim) {
    if (claim.target.kind !== "discrepancy_acknowledge") {
      throw new TypeError("discrepancy recovery target is invalid");
    }
    const result = await this.discrepancies.acknowledge({
      tenant_id: claim.tenant_id,
      discrepancy_id: claim.target.discrepancy_id,
      expected_version: claim.expected_version,
      acknowledged_at: this.clock.now(),
      acknowledged_by: claim.requested_by,
      reason: claim.reason,
    });
    if (result.kind === "not_found") throw new Error("recovery target not found");
    if (result.kind === "conflict") throw new Error("recovery target version conflict");
    return { outcome_code: "discrepancy_acknowledged" } as const;
  }
}

export class ProjectionRebuildRecoveryAction implements RecoveryActionPort {
  constructor(private readonly projections: ProjectionRebuildOwner) {}

  async execute(claim: RecoveryRequestClaim) {
    if (claim.target.kind !== "projection_rebuild") {
      throw new TypeError("projection recovery target is invalid");
    }
    const current = await this.projections.currentVersion(
      claim.tenant_id,
      claim.target.projector_id,
      claim.target.partition_id,
    );
    version(current, claim.expected_version);
    await this.projections.rebuild(
      claim.tenant_id,
      claim.target.projector_id,
      claim.target.partition_id,
    );
    return { outcome_code: "projection_rebuilt" } as const;
  }
}

export class DeliveryReplayRecoveryAction implements RecoveryActionPort {
  constructor(private readonly deliveries: DeliveryReplayOwner) {}

  async execute(claim: RecoveryRequestClaim) {
    if (claim.target.kind !== "delivery_replay") {
      throw new TypeError("delivery recovery target is invalid");
    }
    const current = await this.deliveries.currentVersion(
      claim.tenant_id,
      claim.target.subscription_id,
      claim.target.partition_id,
      claim.target.event_id,
    );
    version(current, claim.expected_version);
    await this.deliveries.replay(
      claim.tenant_id,
      claim.target.subscription_id,
      claim.target.partition_id,
      claim.target.event_id,
    );
    return { outcome_code: "delivery_replayed" } as const;
  }
}
