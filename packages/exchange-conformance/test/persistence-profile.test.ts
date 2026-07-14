import { describe, expect, it } from "vitest";

import { MemoryExchangePersistence } from "@work-fabric/adapter-storage-memory";
import type {
  AtomicCommitResult,
  CapabilityManifest,
  CommandRecord,
  DeadLetterRecord,
  DeliveryClaimResult,
  DeliveryAttempt,
  DeliverySettlement,
  DeliverySettlementResult,
  EventRecord,
  ProjectionFailureRecord,
  PendingDeliveryRecord,
  SnapshotRecord,
} from "@work-fabric/exchange-spi";

import {
  type ExchangePersistenceFactory,
  verifyPersistenceProfile,
} from "../src/index.js";

class MissingCheckpointPositionGuards extends MemoryExchangePersistence {
  override async advanceProjectionCheckpoint(
    projectorId: string,
    partitionId: string,
    expectedPosition: number,
    newPosition: number,
  ): Promise<boolean> {
    if (
      !Number.isSafeInteger(expectedPosition) ||
      expectedPosition < 0 ||
      !Number.isSafeInteger(newPosition) ||
      newPosition < 0
    ) {
      return false;
    }
    return super.advanceProjectionCheckpoint(
      projectorId,
      partitionId,
      expectedPosition,
      newPosition,
    );
  }
}

class MissingFailurePositionGuards extends MemoryExchangePersistence {
  override async putProjectionFailure(
    failure: ProjectionFailureRecord,
  ): Promise<void> {
    if (!Number.isSafeInteger(failure.position) || failure.position <= 0) {
      return;
    }
    return super.putProjectionFailure(failure);
  }
}

type FailureIdentityMutation = "omit-position" | "omit-event-id";

class IncompleteFailureIdentityStore extends MemoryExchangePersistence {
  private readonly mutatedFailures = new Map<string, ProjectionFailureRecord>();

  constructor(private readonly mutation: FailureIdentityMutation) {
    super();
  }

  override async putProjectionFailure(
    failure: ProjectionFailureRecord,
  ): Promise<void> {
    if (!Number.isSafeInteger(failure.position) || failure.position <= 0) {
      throw new Error("failure position must be a positive safe integer");
    }
    const cloned = structuredClone(failure);
    const key = JSON.stringify(
      this.mutation === "omit-position"
        ? [cloned.projector_id, cloned.partition_id, cloned.event_id]
        : [cloned.projector_id, cloned.partition_id, cloned.position],
    );
    if (!this.mutatedFailures.has(key)) {
      this.mutatedFailures.set(key, cloned);
    }
  }

  override async listProjectionFailures(
    projectorId: string,
    partitionId: string,
  ): Promise<readonly ProjectionFailureRecord[]> {
    return structuredClone(
      [...this.mutatedFailures.values()]
        .filter(
          (failure) =>
            failure.projector_id === projectorId &&
            failure.partition_id === partitionId,
        )
        .sort(
          (left, right) =>
            left.position - right.position ||
            (left.event_id < right.event_id
              ? -1
              : left.event_id > right.event_id
                ? 1
                : 0),
        ),
    );
  }
}

class AcceptsContradictoryAttemptStore extends MemoryExchangePersistence {
  override async recordDeliveryAttempt(attempt: DeliveryAttempt): Promise<void> {
    try {
      await super.recordDeliveryAttempt(attempt);
    } catch (error: unknown) {
      if (!(error instanceof Error && /contradictory/i.test(error.message))) {
        throw error;
      }
    }
  }
}

class ClaimsOverlappingDeliveryStore extends MemoryExchangePersistence {
  override async claimPendingDelivery(
    delivery: PendingDeliveryRecord,
    expectedActiveDeliveryId: string | null,
  ): Promise<DeliveryClaimResult> {
    const result = await super.claimPendingDelivery(
      delivery,
      expectedActiveDeliveryId,
    );
    return result.kind === "conflict"
      ? { kind: "claimed", delivery: structuredClone(delivery) }
      : result;
  }
}

class MutableDeliveryReadStore extends MemoryExchangePersistence {
  private readonly cached = new Map<string, PendingDeliveryRecord | null>();

  override async getDelivery(
    deliveryId: string,
  ): Promise<PendingDeliveryRecord | null> {
    if (!this.cached.has(deliveryId)) {
      this.cached.set(deliveryId, await super.getDelivery(deliveryId));
    }
    return this.cached.get(deliveryId) ?? null;
  }
}

class NonAtomicRejectedSettlementStore extends MemoryExchangePersistence {
  override async settleDelivery(
    deliveryId: string,
    expectedOutcome: "pending",
    settlement: DeliverySettlement,
  ): Promise<DeliverySettlementResult> {
    return super.settleDelivery(
      deliveryId,
      expectedOutcome,
      settlement.outcome === "rejected"
        ? { ...settlement, outcome: "acknowledged", reason: null }
        : settlement,
    );
  }
}

class PartialPositionConflictStore extends MemoryExchangePersistence {
  override async settleDelivery(
    deliveryId: string,
    expectedOutcome: "pending",
    settlement: DeliverySettlement,
  ): Promise<DeliverySettlementResult> {
    const result = await super.settleDelivery(
      deliveryId,
      expectedOutcome,
      settlement,
    );
    if (result.kind === "position_conflict" && settlement.outcome === "rejected") {
      for (const event of result.delivery.events) {
        await super.putDeadLetter({
          subscription_id: result.delivery.subscription_id,
          event,
          attempts: result.delivery.attempt,
          reason: settlement.reason ?? "rejected",
          recorded_at: settlement.settled_at,
        });
      }
    }
    return result;
  }
}

describe("verifyPersistenceProfile", () => {
  it("rejects an Adapter missing checkpoint position guards", async () => {
    await expect(
      verifyPersistenceProfile(() => new MissingCheckpointPositionGuards()),
    ).rejects.toThrow(/checkpoint position validation/i);
  });

  it("rejects an Adapter missing Projection Failure position guards", async () => {
    await expect(
      verifyPersistenceProfile(() => new MissingFailurePositionGuards()),
    ).rejects.toThrow(/Projection Failure position validation/i);
  });

  for (const mutation of ["omit-position", "omit-event-id"] as const) {
    it(`rejects a Projection Failure key that ${mutation}`, async () => {
      await expect(
        verifyPersistenceProfile(
          () => new IncompleteFailureIdentityStore(mutation),
        ),
      ).rejects.toThrow(/Projection Failure.*four-part identity/i);
    });
  }

  it.each([
    [
      "contradictory Delivery Attempt replay",
      () => new AcceptsContradictoryAttemptStore(),
      /delivery attempts/i,
    ],
    [
      "overlapping pending Delivery",
      () => new ClaimsOverlappingDeliveryStore(),
      /pending Delivery claim/i,
    ],
    [
      "mutable Delivery read",
      () => new MutableDeliveryReadStore(),
      /pending Delivery claim/i,
    ],
    [
      "non-atomic rejected settlement",
      () => new NonAtomicRejectedSettlementStore(),
      /rejected Delivery settlement/i,
    ],
    [
      "partial position-conflict settlement",
      () => new PartialPositionConflictStore(),
      /position conflict/i,
    ],
  ] as const)("rejects %s", async (_name, factory, scenario) => {
    await expect(verifyPersistenceProfile(factory)).rejects.toThrow(scenario);
  });

  it("names the scenario when creating a fresh store fails", async () => {
    const factory = (): never => {
      throw new Error("factory failed");
    };

    await expect(verifyPersistenceProfile(factory)).rejects.toThrow(
      /required capabilities.*factory failed/is,
    );
  });

  it("rejects a missing required capability before behavior scenarios run", async () => {
    let behaviorScenarioRan = false;
    const behaviorFailure = (): never => {
      behaviorScenarioRan = true;
      throw new Error("behavior scenario unexpectedly ran");
    };
    const manifest: CapabilityManifest = {
      profile: "exchange.persistence.v1",
      adapter: "non-conforming-test-double",
      capabilities: {
        expected_stream_version: true,
        ordered_streams: true,
        atomic_multi_stream_append: false,
        transactional_idempotency: true,
        partitioned_journal: true,
        immutable_events: true,
      },
    };
    const factory: ExchangePersistenceFactory = () => ({
      manifest,
      async readStream(): Promise<readonly EventRecord[]> {
        return behaviorFailure();
      },
      async readPartition(): Promise<readonly EventRecord[]> {
        return behaviorFailure();
      },
      async findCommand(): Promise<CommandRecord | null> {
        return behaviorFailure();
      },
      async commitAtomically(): Promise<AtomicCommitResult> {
        return behaviorFailure();
      },
      async loadSnapshot(): Promise<SnapshotRecord | null> {
        return behaviorFailure();
      },
      async saveSnapshot(): Promise<void> {
        return behaviorFailure();
      },
      async deleteSnapshot(): Promise<void> {
        return behaviorFailure();
      },
      async loadProjectionCheckpoint(): Promise<number> {
        return behaviorFailure();
      },
      async advanceProjectionCheckpoint(): Promise<boolean> {
        return behaviorFailure();
      },
      async resetProjectionCheckpoint(): Promise<void> {
        return behaviorFailure();
      },
      async putProjectionFailure(
        _failure: ProjectionFailureRecord,
      ): Promise<void> {
        return behaviorFailure();
      },
      async listProjectionFailures(): Promise<
        readonly ProjectionFailureRecord[]
      > {
        return behaviorFailure();
      },
      async loadDeliveryPosition(): Promise<number> {
        return behaviorFailure();
      },
      async recordDeliveryAttempt(_attempt: DeliveryAttempt): Promise<void> {
        return behaviorFailure();
      },
      async listDeliveryAttempts(): Promise<readonly DeliveryAttempt[]> {
        return behaviorFailure();
      },
      async advanceDeliveryPosition(): Promise<boolean> {
        return behaviorFailure();
      },
      async putDeadLetter(_record: DeadLetterRecord): Promise<void> {
        return behaviorFailure();
      },
      async listDeadLetters(): Promise<readonly DeadLetterRecord[]> {
        return behaviorFailure();
      },
      async getActiveDelivery(): Promise<PendingDeliveryRecord | null> {
        return behaviorFailure();
      },
      async claimPendingDelivery(): Promise<DeliveryClaimResult> {
        return behaviorFailure();
      },
      async getDelivery(): Promise<PendingDeliveryRecord | null> {
        return behaviorFailure();
      },
      async settleDelivery(
        _deliveryId: string,
        _expectedOutcome: "pending",
        _settlement: DeliverySettlement,
      ): Promise<DeliverySettlementResult> {
        return behaviorFailure();
      },
    });

    await expect(verifyPersistenceProfile(factory)).rejects.toThrow(
      /required capabilities.*atomic_multi_stream_append/is,
    );
    expect(behaviorScenarioRan).toBe(false);
  });
});
