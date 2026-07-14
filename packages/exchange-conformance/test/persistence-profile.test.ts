import { describe, expect, it } from "vitest";

import type {
  AtomicCommitResult,
  CapabilityManifest,
  CommandRecord,
  DeadLetterRecord,
  DeliveryAttempt,
  EventRecord,
  SnapshotRecord,
} from "@work-fabric/exchange-spi";

import {
  type ExchangePersistenceFactory,
  verifyPersistenceProfile,
} from "../src/index.js";

describe("verifyPersistenceProfile", () => {
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
      async loadDeliveryPosition(): Promise<number> {
        return behaviorFailure();
      },
      async recordDeliveryAttempt(_attempt: DeliveryAttempt): Promise<void> {
        return behaviorFailure();
      },
      async advanceDeliveryPosition(): Promise<boolean> {
        return behaviorFailure();
      },
      async putDeadLetter(_record: DeadLetterRecord): Promise<void> {
        return behaviorFailure();
      },
    });

    await expect(verifyPersistenceProfile(factory)).rejects.toThrow(
      /required capabilities.*atomic_multi_stream_append/is,
    );
    expect(behaviorScenarioRan).toBe(false);
  });
});
