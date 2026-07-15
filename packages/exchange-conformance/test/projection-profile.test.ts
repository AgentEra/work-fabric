import { describe, expect, it } from "vitest";

import { MemoryHandoffReadModelStore } from "@work-fabric/exchange-runtime";
import type {
  CapabilityManifest,
  HandoffReadModel,
  HandoffReadModelStore,
} from "@work-fabric/exchange-spi";

import { verifyProjectionProfile } from "../src/index.js";

type Mutation =
  | "none"
  | "same-version-overwrite"
  | "stale-overwrite"
  | "identity-change"
  | "non-string-identity"
  | "invalid-stream-version"
  | "mutable-values"
  | "clear-all"
  | "reverse-list";

const manifest: CapabilityManifest = {
  profile: "exchange.projection.v1",
  adapter: "mutated-test-adapter",
  capabilities: {
    idempotent_upsert: true,
    partition_reset: true,
    immutable_reads: true,
  },
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

class MutatedProjectionStore implements HandoffReadModelStore {
  private readonly models = new Map<string, HandoffReadModel>();

  constructor(private readonly mutation: Mutation) {}

  get manifest(): CapabilityManifest {
    return clone(manifest);
  }

  async getHandoff(handoffId: string): Promise<HandoffReadModel | null> {
    const model = this.models.get(handoffId);
    if (model === undefined) return null;
    return this.mutation === "mutable-values" ? model : clone(model);
  }

  async putHandoff(model: HandoffReadModel): Promise<void> {
    const candidate = this.mutation === "mutable-values" ? model : clone(model);
    if (
      this.mutation !== "non-string-identity" &&
      [candidate.tenant_id, candidate.partition_id, candidate.handoff_id].some(
        (value) => typeof value !== "string" || value.length === 0,
      )
    ) {
      throw new Error("invalid identity");
    }
    if (
      (!Number.isSafeInteger(candidate.stream_version) ||
        candidate.stream_version <= 0) &&
      this.mutation !== "invalid-stream-version"
    ) {
      throw new Error("unsafe stream version");
    }
    const existing = this.models.get(candidate.handoff_id);
    if (existing !== undefined) {
      if (candidate.stream_version < existing.stream_version) {
        if (this.mutation !== "stale-overwrite") throw new Error("stale");
      } else if (candidate.stream_version === existing.stream_version) {
        if (JSON.stringify(candidate) === JSON.stringify(existing)) return;
        if (this.mutation !== "same-version-overwrite") {
          throw new Error("inconsistent");
        }
      } else if (
        (candidate.tenant_id !== existing.tenant_id ||
          candidate.partition_id !== existing.partition_id) &&
        this.mutation !== "identity-change"
      ) {
        throw new Error("identity");
      }
    }
    this.models.set(candidate.handoff_id, candidate);
  }

  async listHandoffs(
    partitionId: string,
  ): Promise<readonly HandoffReadModel[]> {
    const listed = [...this.models.values()]
      .filter((model) => model.partition_id === partitionId)
      .sort((left, right) =>
        left.handoff_id < right.handoff_id
          ? -1
          : left.handoff_id > right.handoff_id
            ? 1
            : 0,
      );
    if (this.mutation === "reverse-list") listed.reverse();
    return this.mutation === "mutable-values" ? listed : clone(listed);
  }

  async clearPartition(partitionId: string): Promise<void> {
    if (this.mutation === "clear-all") {
      this.models.clear();
      return;
    }
    for (const [handoffId, model] of this.models) {
      if (model.partition_id === partitionId) this.models.delete(handoffId);
    }
  }
}

describe("verifyProjectionProfile", () => {
  it("accepts the Memory reference Projection Adapter", async () => {
    await expect(
      verifyProjectionProfile(() => new MemoryHandoffReadModelStore()),
    ).resolves.toBeUndefined();
  });

  it("rejects a missing capability before behavior scenarios run", async () => {
    let behaviorRan = false;
    const store: HandoffReadModelStore = {
      manifest: {
        ...manifest,
        capabilities: { ...manifest.capabilities, immutable_reads: false },
      },
      async getHandoff() {
        behaviorRan = true;
        throw new Error("behavior must not run");
      },
      async putHandoff() {
        behaviorRan = true;
        throw new Error("behavior must not run");
      },
      async listHandoffs() {
        behaviorRan = true;
        throw new Error("behavior must not run");
      },
      async clearPartition() {
        behaviorRan = true;
        throw new Error("behavior must not run");
      },
    };

    await expect(verifyProjectionProfile(() => store)).rejects.toThrow(
      /required capabilities.*immutable_reads/is,
    );
    expect(behaviorRan).toBe(false);
  });

  for (const [mutation, expectedScenario] of [
    ["same-version-overwrite", "inconsistent same-version"],
    ["stale-overwrite", "stale write"],
    ["identity-change", "identity"],
    ["non-string-identity", "invalid identity"],
    ["invalid-stream-version", "positive safe stream version"],
    ["mutable-values", "immutable"],
    ["clear-all", "Partition isolation"],
    ["reverse-list", "deterministic list"],
  ] as const) {
    it(`rejects the ${mutation} mutation`, async () => {
      await expect(
        verifyProjectionProfile(() => new MutatedProjectionStore(mutation)),
      ).rejects.toThrow(new RegExp(expectedScenario, "i"));
    });
  }
});
