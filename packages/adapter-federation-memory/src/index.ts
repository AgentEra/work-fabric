import type {
  FederationClock,
  FederationReplayBeginResult,
  FederationReplayStore,
} from "@work-fabric/federation-spi";

interface ReplayRecord {
  readonly request_digest: string;
  readonly expires_at: string;
  response?: Uint8Array;
}

export interface MemoryFederationReplayStoreOptions {
  readonly max_records: number;
  readonly clock: FederationClock;
}

function key(sourceExchangeId: string, messageId: string): string {
  return `${sourceExchangeId.length}:${sourceExchangeId}${messageId}`;
}

export class MemoryFederationReplayStore implements FederationReplayStore {
  private readonly records = new Map<string, ReplayRecord>();

  constructor(private readonly options: MemoryFederationReplayStoreOptions) {
    if (
      !Number.isSafeInteger(options.max_records) ||
      options.max_records < 1 ||
      options.max_records > 100_000
    ) {
      throw new RangeError("max_records must be between 1 and 100000");
    }
    if (!Number.isFinite(Date.parse(options.clock.now()))) {
      throw new RangeError("clock.now() must return a valid timestamp");
    }
  }

  async begin(input: {
    readonly source_exchange_id: string;
    readonly message_id: string;
    readonly request_digest: string;
    readonly expires_at: string;
  }): Promise<FederationReplayBeginResult> {
    this.pruneExpired();
    const replayKey = key(input.source_exchange_id, input.message_id);
    const current = this.records.get(replayKey);
    if (current !== undefined) {
      if (current.request_digest !== input.request_digest) return { kind: "conflict" };
      if (current.response !== undefined) {
        return { kind: "completed", response: Uint8Array.from(current.response) };
      }
      return { kind: "pending" };
    }
    if (this.records.size >= this.options.max_records) {
      throw new RangeError("federation replay store capacity exceeded");
    }
    if (!Number.isFinite(Date.parse(input.expires_at))) {
      throw new RangeError("expires_at must be a valid timestamp");
    }
    this.records.set(replayKey, {
      request_digest: input.request_digest,
      expires_at: input.expires_at,
    });
    return { kind: "new" };
  }

  async complete(input: {
    readonly source_exchange_id: string;
    readonly message_id: string;
    readonly request_digest: string;
    readonly response: Uint8Array;
  }): Promise<Uint8Array> {
    const replayKey = key(input.source_exchange_id, input.message_id);
    const current = this.records.get(replayKey);
    if (current === undefined || current.request_digest !== input.request_digest) {
      throw new Error("federation replay record does not match completion");
    }
    if (current.response === undefined) current.response = Uint8Array.from(input.response);
    return Uint8Array.from(current.response);
  }

  private pruneExpired(): void {
    const now = Date.parse(this.options.clock.now());
    if (!Number.isFinite(now)) throw new RangeError("clock.now() must return a valid timestamp");
    for (const [replayKey, record] of this.records) {
      if (Date.parse(record.expires_at) < now) this.records.delete(replayKey);
    }
  }
}
