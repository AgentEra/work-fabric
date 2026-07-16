import type {
  ClusterCapabilityManifest,
  PartitionWakeupConsumer,
  WakeupDelivery,
} from "@work-fabric/cluster-spi";
import {
  observeSemanticSafely,
  type SemanticTelemetryObserver,
} from "@work-fabric/operations-spi";

import {
  normalizeNatsWakeupRuntimeConfig,
  type NatsWakeupRuntimeConfig,
  type NatsWakeupRuntimeConfigInput,
} from "./config.js";
import { NatsWakeupError } from "./errors.js";
import { natsWakeupManifest } from "./manifest.js";
import type {
  WakeupJetStreamMessage,
  WakeupJetStreamPort,
} from "./nats-port.js";
import type { HmacWakeupSubjectCodec } from "./subject-codec.js";
import { decodeWakeup } from "./wakeup-codec.js";

export interface NatsWakeupConsumerOptions {
  readonly port: WakeupJetStreamPort;
  readonly subjects: HmacWakeupSubjectCodec;
  readonly stream: string;
  readonly consumer: string;
  readonly config?: NatsWakeupRuntimeConfigInput;
  readonly telemetry?: SemanticTelemetryObserver;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

export class NatsWakeupConsumer implements PartitionWakeupConsumer {
  private readonly config: NatsWakeupRuntimeConfig;
  private readonly closeController = new AbortController();
  private activeNext = false;
  private activePull: Promise<WakeupJetStreamMessage | null> | null = null;
  private closed = false;

  constructor(private readonly options: NatsWakeupConsumerOptions) {
    if (options.stream.length === 0 || options.consumer.length === 0) {
      throw new NatsWakeupError("wakeup_transport_unavailable");
    }
    this.config = normalizeNatsWakeupRuntimeConfig(options.config ?? {});
  }

  get manifest(): ClusterCapabilityManifest {
    return natsWakeupManifest();
  }

  async next(signal: AbortSignal): Promise<WakeupDelivery | null> {
    if (this.closed) throw new NatsWakeupError("wakeup_adapter_closed");
    if (signal.aborted) throw abortReason(signal);
    if (this.activeNext || this.activePull !== null) {
      throw new NatsWakeupError("wakeup_transport_unavailable");
    }
    this.activeNext = true;
    const deadline = Date.now() + this.config.pull_expires_ms;
    let poisonCount = 0;
    try {
      while (poisonCount < this.config.max_poison_per_pull) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        const message = await this.pull(
          signal,
          poisonCount === 0 ? this.config.pull_expires_ms : remaining,
        );
        if (message === null) return null;
        try {
          const wakeup = decodeWakeup(message.payload);
          this.options.subjects.assertMatches(message.subject, wakeup);
          return this.delivery(message, wakeup);
        } catch {
          poisonCount += 1;
          observeSemanticSafely(this.options.telemetry, {
            operation: "cluster_wakeup_transport",
            outcome: "failed",
            category: "cluster",
            duration_ms: 0,
            count: 1,
          });
          try {
            await message.terminate();
          } catch {
            throw new NatsWakeupError("wakeup_transport_unavailable");
          }
        }
      }
      return null;
    } finally {
      this.activeNext = false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closeController.abort(new NatsWakeupError("wakeup_adapter_closed"));
  }

  private async pull(
    signal: AbortSignal,
    expiresMs: number,
  ): Promise<WakeupJetStreamMessage | null> {
    const localExpiresMs = Math.max(
      1,
      Math.min(this.config.pull_expires_ms, expiresMs),
    );
    const lower = this.options.port.pull({
      stream: this.options.stream,
      consumer: this.options.consumer,
      expires_ms: Math.max(1_000, localExpiresMs),
    });
    this.activePull = lower;
    void lower.finally(() => {
      if (this.activePull === lower) this.activePull = null;
    }).catch(() => undefined);

    let callerAbort: () => void = () => undefined;
    let closeAbort: () => void = () => undefined;
    const abort = new Promise<never>((_resolve, reject) => {
      callerAbort = (): void => reject(abortReason(signal));
      closeAbort = (): void => reject(
        new NatsWakeupError("wakeup_adapter_closed"),
      );
      signal.addEventListener("abort", callerAbort, { once: true });
      this.closeController.signal.addEventListener("abort", closeAbort, { once: true });
    });
    let timer: ReturnType<typeof setTimeout>;
    const expired = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), localExpiresMs);
      timer.unref?.();
    });

    try {
      return await Promise.race([lower, abort, expired]);
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      if (this.closed) throw new NatsWakeupError("wakeup_adapter_closed");
      if (error instanceof NatsWakeupError) throw error;
      observeSemanticSafely(this.options.telemetry, {
        operation: "cluster_wakeup_transport",
        outcome: "retryable",
        category: "cluster",
        duration_ms: 0,
        count: 1,
      });
      throw new NatsWakeupError("wakeup_transport_unavailable");
    } finally {
      clearTimeout(timer!);
      signal.removeEventListener("abort", callerAbort);
      this.closeController.signal.removeEventListener("abort", closeAbort);
    }
  }

  private delivery(
    message: WakeupJetStreamMessage,
    wakeup: WakeupDelivery["wakeup"],
  ): WakeupDelivery {
    let settled = false;
    const settle = async (operation: () => Promise<void>): Promise<void> => {
      if (settled) throw new NatsWakeupError("wakeup_delivery_settled");
      settled = true;
      try {
        await operation();
      } catch {
        throw new NatsWakeupError("wakeup_transport_unavailable");
      }
    };
    return {
      wakeup: structuredClone(wakeup),
      acknowledge: () => settle(() => message.acknowledge()),
      retry: () => settle(() => message.retry(this.config.retry_delay_ms)),
    };
  }
}
