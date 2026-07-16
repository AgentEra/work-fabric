import type { NatsConnection } from "@nats-io/transport-node";
import type {
  ClusterCapabilityManifest,
  PartitionWakeup,
  PartitionWakeupConsumer,
  PartitionWakeupPublisher,
  WakeupDelivery,
} from "@work-fabric/cluster-spi";
import type { SemanticTelemetryObserver } from "@work-fabric/operations-spi";

import type { NatsWakeupRuntimeConfigInput } from "./config.js";
import { NatsWakeupError } from "./errors.js";
import { natsWakeupManifest } from "./manifest.js";
import { NatsJetStreamPort, type WakeupJetStreamPort } from "./nats-port.js";
import { NatsWakeupConsumer } from "./nats-wakeup-consumer.js";
import { NatsWakeupPublisher } from "./nats-wakeup-publisher.js";
import {
  HmacWakeupSubjectCodec,
  type HmacWakeupSubjectCodecOptions,
} from "./subject-codec.js";

export interface NatsWakeupAdapterPortOptions {
  readonly port: WakeupJetStreamPort;
  readonly subjects: HmacWakeupSubjectCodec;
  readonly stream: string;
  readonly consumer: string;
  readonly config?: NatsWakeupRuntimeConfigInput;
  readonly telemetry?: SemanticTelemetryObserver;
}

export interface NatsWakeupRuntimeOptions
  extends HmacWakeupSubjectCodecOptions
{
  readonly connection: NatsConnection;
  readonly stream: string;
  readonly consumer: string;
  readonly config?: NatsWakeupRuntimeConfigInput;
  readonly telemetry?: SemanticTelemetryObserver;
}

export class NatsWakeupAdapter
  implements PartitionWakeupPublisher, PartitionWakeupConsumer
{
  private readonly publisher: NatsWakeupPublisher;
  private readonly consumer: NatsWakeupConsumer;
  private closed = false;

  constructor(options: NatsWakeupAdapterPortOptions) {
    this.publisher = new NatsWakeupPublisher(options);
    this.consumer = new NatsWakeupConsumer(options);
  }

  get manifest(): ClusterCapabilityManifest {
    return natsWakeupManifest();
  }

  async publish(
    wakeup: PartitionWakeup,
  ): Promise<"accepted" | "retryable_failure"> {
    if (this.closed) throw new NatsWakeupError("wakeup_adapter_closed");
    return await this.publisher.publish(wakeup);
  }

  async next(signal: AbortSignal): Promise<WakeupDelivery | null> {
    if (this.closed) throw new NatsWakeupError("wakeup_adapter_closed");
    return await this.consumer.next(signal);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.consumer.close();
  }
}

export async function createNatsWakeupAdapter(
  options: NatsWakeupRuntimeOptions,
): Promise<NatsWakeupAdapter> {
  const subjects = new HmacWakeupSubjectCodec(options);
  return new NatsWakeupAdapter({
    port: new NatsJetStreamPort(options.connection),
    subjects,
    stream: options.stream,
    consumer: options.consumer,
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
  });
}
