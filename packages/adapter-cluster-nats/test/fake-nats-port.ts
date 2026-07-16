import type {
  WakeupJetStreamMessage,
  WakeupJetStreamPort,
} from "../src/nats-port.js";

export interface FakePublication {
  readonly subject: string;
  readonly payload: Uint8Array;
  readonly message_id: string;
}

export class FakeWakeupMessage implements WakeupJetStreamMessage {
  acknowledgements = 0;
  retries: number[] = [];
  terminations = 0;

  constructor(
    readonly subject: string,
    readonly payload: Uint8Array,
    readonly redelivered = false,
    private readonly onRetry?: (delayMs: number) => void,
  ) {}

  async acknowledge(): Promise<void> {
    this.acknowledgements += 1;
  }

  async retry(delayMs: number): Promise<void> {
    this.retries.push(delayMs);
    this.onRetry?.(delayMs);
  }

  async terminate(): Promise<void> {
    this.terminations += 1;
  }
}

export class FakeWakeupJetStreamPort implements WakeupJetStreamPort {
  readonly publications: FakePublication[] = [];
  readonly messages: FakeWakeupMessage[] = [];
  readonly pulls: Array<{
    readonly stream: string;
    readonly consumer: string;
    readonly expires_ms: number;
  }> = [];
  publishFailure: Error | undefined;
  pullFailure: Error | undefined;
  pendingPull: Promise<WakeupJetStreamMessage | null> | undefined;

  constructor(private readonly loopback = false) {}

  async publish(input: FakePublication): Promise<void> {
    if (this.publishFailure !== undefined) throw this.publishFailure;
    this.publications.push({
      ...input,
      payload: Uint8Array.from(input.payload),
    });
    if (this.loopback) {
      this.enqueue(input.subject, input.payload, { retry_to_front: true });
    }
  }

  async pull(input: {
    readonly stream: string;
    readonly consumer: string;
    readonly expires_ms: number;
  }): Promise<WakeupJetStreamMessage | null> {
    this.pulls.push(input);
    if (this.pullFailure !== undefined) throw this.pullFailure;
    if (this.pendingPull !== undefined) return this.pendingPull;
    return this.messages.shift() ?? null;
  }

  enqueue(
    subject: string,
    payload: Uint8Array,
    options: { readonly redelivered?: boolean; readonly retry_to_front?: boolean } = {},
  ): FakeWakeupMessage {
    let message: FakeWakeupMessage;
    message = new FakeWakeupMessage(
      subject,
      Uint8Array.from(payload),
      options.redelivered ?? false,
      options.retry_to_front === true
        ? () => this.messages.unshift(message)
        : undefined,
    );
    this.messages.push(message);
    return message;
  }
}
