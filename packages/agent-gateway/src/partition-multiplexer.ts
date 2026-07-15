import type {
  EventDelivery,
  HandoffReadModel,
} from "@work-fabric/sdk-typescript";

import { AgentGatewayError } from "./errors.js";
import type {
  AgentGatewayClient,
  IncomingHandoff,
} from "./agent-endpoint-session.js";
import type { BoundedAsyncQueue } from "./bounded-async-queue.js";

export interface MultiplexerDependencies {
  readonly client: AgentGatewayClient;
  readonly endpointId: string;
  readonly subscriptionId: string;
  readonly refreshMs: number;
  readonly maxPartitions: number;
  readonly queue: BoundedAsyncQueue<IncomingHandoff>;
  readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly incoming: (
    partitionId: string,
    delivery: EventDelivery,
    handoff: HandoffReadModel,
  ) => IncomingHandoff;
  readonly failed: (error: unknown) => void;
}

export class PartitionMultiplexer {
  private readonly controller = new AbortController();
  private readonly streams = new Map<string, {
    readonly controller: AbortController;
    readonly running: Promise<void>;
  }>();
  private readonly cursors = new Map<string, string>();
  private running: Promise<void> | null = null;

  constructor(private readonly dependencies: MultiplexerDependencies) {}

  start(): void {
    if (this.running !== null) return;
    this.running = this.run().catch((error) => {
      if (!this.controller.signal.aborted) this.dependencies.failed(error);
    });
  }

  async stop(): Promise<void> {
    this.controller.abort();
    await Promise.allSettled([
      ...(this.running === null ? [] : [this.running]),
      ...[...this.streams.values()].map((stream) => stream.running),
    ]);
  }

  private async run(): Promise<void> {
    while (!this.controller.signal.aborted) {
      const partitions = await this.listPartitions();
      this.synchronize(partitions);
      await this.dependencies.sleep(
        this.dependencies.refreshMs,
        this.controller.signal,
      );
    }
  }

  private async listPartitions(): Promise<readonly string[]> {
    const partitions: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.dependencies.client.endpoints.listInboxPartitions(
        this.dependencies.endpointId,
        {
          ...(cursor === undefined ? {} : { cursor }),
          limit: Math.min(100, this.dependencies.maxPartitions - partitions.length + 1),
        },
        { signal: this.controller.signal },
      );
      for (const item of page.items) {
        if (!partitions.includes(item.partition_id)) partitions.push(item.partition_id);
        if (partitions.length > this.dependencies.maxPartitions) {
          throw new AgentGatewayError(
            "partition_limit_exceeded",
            "Endpoint inbox exceeds the configured active Partition bound",
          );
        }
      }
      cursor = page.next_cursor;
    } while (cursor !== undefined);
    return partitions;
  }

  private synchronize(partitions: readonly string[]): void {
    const desired = new Set(partitions);
    for (const partition of partitions) {
      if (this.streams.has(partition)) continue;
      const controller = new AbortController();
      const abort = () => controller.abort(this.controller.signal.reason);
      this.controller.signal.addEventListener("abort", abort, { once: true });
      const running = this.runStream(partition, controller.signal).finally(() => {
        this.controller.signal.removeEventListener("abort", abort);
        this.streams.delete(partition);
      });
      this.streams.set(partition, { controller, running });
    }
    for (const [partition, stream] of this.streams) {
      if (!desired.has(partition)) {
        stream.controller.abort("partition_inactive");
        this.cursors.delete(partition);
      }
    }
  }

  private async runStream(
    partitionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    for await (const delivery of this.dependencies.client.subscriptions.stream(
      this.dependencies.subscriptionId,
      {
        partitionId,
        ...(this.cursors.get(partitionId) === undefined
          ? {}
          : { cursor: this.cursors.get(partitionId)! }),
      },
      { signal },
    )) {
      this.cursors.set(partitionId, delivery.next_cursor);
      const handoffId = delivery.events.at(-1)?.wfhandoff;
      if (handoffId === undefined) {
        throw new AgentGatewayError(
          "connection_failed",
          "Delivery does not identify a Handoff",
        );
      }
      const handoff = await this.dependencies.client.queries.getHandoff(
        handoffId,
        { signal },
      );
      await this.dependencies.queue.push(
        this.dependencies.incoming(partitionId, delivery, handoff),
        signal,
      );
    }
  }
}
