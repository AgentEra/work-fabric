import { isDeepStrictEqual } from "node:util";

import type {
  CapabilityManifest,
  HandoffReadModel,
  HandoffReadModelStore,
} from "@work-fabric/exchange-spi";

const manifest: CapabilityManifest = {
  profile: "exchange.projection.v1",
  adapter: "memory-handoff-read-model",
  capabilities: {
    idempotent_upsert: true,
    partition_reset: true,
    immutable_reads: true,
  },
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function requireNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function validateModel(model: HandoffReadModel): void {
  requireNonEmpty(model.tenant_id, "tenant_id");
  requireNonEmpty(model.partition_id, "partition_id");
  requireNonEmpty(model.handoff_id, "handoff_id");
  if (!Number.isSafeInteger(model.stream_version) || model.stream_version <= 0) {
    throw new Error("stream_version must be a positive safe integer");
  }
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class MemoryHandoffReadModelStore implements HandoffReadModelStore {
  private readonly models = new Map<string, HandoffReadModel>();

  get manifest(): CapabilityManifest {
    return clone(manifest);
  }

  async getHandoff(handoffId: string): Promise<HandoffReadModel | null> {
    requireNonEmpty(handoffId, "handoff_id");
    const model = this.models.get(handoffId);
    return model === undefined ? null : clone(model);
  }

  async putHandoff(model: HandoffReadModel): Promise<void> {
    const candidate = clone(model);
    validateModel(candidate);
    const existing = this.models.get(candidate.handoff_id);
    if (existing === undefined) {
      this.models.set(candidate.handoff_id, candidate);
      return;
    }
    if (
      existing.tenant_id !== candidate.tenant_id ||
      existing.partition_id !== candidate.partition_id ||
      existing.handoff_id !== candidate.handoff_id
    ) {
      throw new Error("Handoff read model identity cannot change");
    }
    if (candidate.stream_version < existing.stream_version) {
      throw new Error("Stale Handoff read model version cannot overwrite a newer version");
    }
    if (candidate.stream_version === existing.stream_version) {
      if (isDeepStrictEqual(existing, candidate)) return;
      throw new Error("Inconsistent Handoff read model content for the same version");
    }
    this.models.set(candidate.handoff_id, candidate);
  }

  async listHandoffs(
    partitionId: string,
  ): Promise<readonly HandoffReadModel[]> {
    requireNonEmpty(partitionId, "partition_id");
    return clone(
      [...this.models.values()]
        .filter((model) => model.partition_id === partitionId)
        .sort((left, right) =>
          compareCodePoints(left.handoff_id, right.handoff_id),
        ),
    );
  }

  async clearPartition(partitionId: string): Promise<void> {
    requireNonEmpty(partitionId, "partition_id");
    for (const [handoffId, model] of this.models) {
      if (model.partition_id === partitionId) this.models.delete(handoffId);
    }
  }
}
