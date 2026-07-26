import type { RuntimeProgress } from "@work-fabric/agent-runtime-spi";

import { invalid } from "./errors.js";

const MAX_MESSAGE_LENGTH = 4_096;

export class ProgressCoalescer {
  private pending: RuntimeProgress | null = null;
  private lastSequence = 0;
  private lastEmittedAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> = Promise.resolve();

  constructor(
    private readonly intervalMs: number,
    private readonly emit: (update: RuntimeProgress) => Promise<void>,
    private readonly clock: () => number = () => Date.now(),
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) invalid("invalid_progress_interval", "progress_interval_ms");
  }

  async push(update: RuntimeProgress): Promise<void> {
    if (!Number.isSafeInteger(update.sequence) || update.sequence <= this.lastSequence) invalid("invalid_progress", "sequence");
    if (update.progress !== null && (!Number.isFinite(update.progress) || update.progress < 0 || update.progress > 1)) invalid("invalid_progress", "progress");
    if (typeof update.message !== "string" || update.message.length === 0) invalid("invalid_progress", "message");
    if (typeof update.observed_at !== "string" || update.observed_at.length === 0) invalid("invalid_progress", "observed_at");
    this.lastSequence = update.sequence;
    this.pending = {
      ...update,
      message: update.message.slice(0, MAX_MESSAGE_LENGTH),
    };
    this.schedule();
  }

  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.enqueueFlush();
  }

  private schedule(): void {
    if (this.timer !== null) return;
    const wait = Math.max(0, this.intervalMs - (this.clock() - this.lastEmittedAt));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.enqueueFlush();
    }, wait);
  }

  private enqueueFlush(): Promise<void> {
    this.flushing = this.flushing.then(async () => {
      // A second timer can enqueue while an async emit is in flight.  Compute
      // the delay inside the serialized chain, after the prior emit has set
      // lastEmittedAt, so those updates cannot be emitted back-to-back.
      const wait = Math.max(0, this.intervalMs - (this.clock() - this.lastEmittedAt));
      if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
      const update = this.pending;
      if (update === null) return;
      this.pending = null;
      await this.emit(update);
      this.lastEmittedAt = this.clock();
      if (this.pending !== null) this.schedule();
    });
    return this.flushing;
  }
}
