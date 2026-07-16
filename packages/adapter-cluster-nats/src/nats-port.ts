import { jetstream, type Consumer, type JetStreamClient } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";

export interface WakeupJetStreamPublishInput {
  readonly subject: string;
  readonly payload: Uint8Array;
  readonly message_id: string;
}

export interface WakeupJetStreamPullInput {
  readonly stream: string;
  readonly consumer: string;
  readonly expires_ms: number;
}

export interface WakeupJetStreamMessage {
  readonly subject: string;
  readonly payload: Uint8Array;
  readonly redelivered: boolean;
  acknowledge(): Promise<void>;
  retry(delayMs: number): Promise<void>;
  terminate(): Promise<void>;
}

export interface WakeupJetStreamPort {
  publish(input: WakeupJetStreamPublishInput): Promise<void>;
  pull(input: WakeupJetStreamPullInput): Promise<WakeupJetStreamMessage | null>;
}

export class NatsJetStreamPort implements WakeupJetStreamPort {
  private readonly client: JetStreamClient;
  private readonly consumers = new Map<string, Promise<Consumer>>();

  constructor(connection: NatsConnection) {
    this.client = jetstream(connection);
  }

  async publish(input: WakeupJetStreamPublishInput): Promise<void> {
    await this.client.publish(input.subject, input.payload, {
      msgID: input.message_id,
    });
  }

  async pull(input: WakeupJetStreamPullInput): Promise<WakeupJetStreamMessage | null> {
    const key = `${input.stream}\u0000${input.consumer}`;
    let pending = this.consumers.get(key);
    if (pending === undefined) {
      pending = this.client.consumers.get(input.stream, input.consumer);
      this.consumers.set(key, pending);
    }
    let consumer: Consumer;
    try {
      consumer = await pending;
    } catch (error) {
      this.consumers.delete(key);
      throw error;
    }
    const message = await consumer.next({ expires: input.expires_ms });
    if (message === null) return null;
    return {
      subject: message.subject,
      payload: Uint8Array.from(message.data),
      redelivered: message.redelivered,
      acknowledge: async () => message.ack(),
      retry: async (delayMs) => message.nak(delayMs),
      terminate: async () => message.term(),
    };
  }
}
