interface Taker<T> {
  readonly resolve: (result: IteratorResult<T>) => void;
  readonly reject: (error: unknown) => void;
}

interface ProducerWaiter {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

export class BoundedAsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly takers: Taker<T>[] = [];
  private readonly producers: ProducerWaiter[] = [];
  private ended = false;
  private failure: unknown = null;

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new TypeError("capacity must be a positive safe integer");
    }
  }

  async push(value: T, signal?: AbortSignal): Promise<void> {
    if (this.ended) throw this.failure ?? new Error("queue is closed");
    const taker = this.takers.shift();
    if (taker !== undefined) {
      taker.resolve({ value, done: false });
      return;
    }
    while (this.items.length >= this.capacity) {
      await this.waitForCapacity(signal);
      if (this.ended) throw this.failure ?? new Error("queue is closed");
    }
    this.items.push(value);
  }

  close(error?: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = error ?? null;
    for (const producer of this.producers.splice(0)) {
      producer.reject(error ?? new Error("queue is closed"));
    }
    for (const taker of this.takers.splice(0)) {
      if (error === undefined) taker.resolve({ value: undefined, done: true });
      else taker.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
      return: async () => ({ value: undefined, done: true }),
    };
  }

  private next(): Promise<IteratorResult<T>> {
    const item = this.items.shift();
    if (item !== undefined) {
      this.producers.shift()?.resolve();
      return Promise.resolve({ value: item, done: false });
    }
    if (this.ended) {
      return this.failure === null
        ? Promise.resolve({ value: undefined, done: true })
        : Promise.reject(this.failure);
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.takers.push({ resolve, reject });
    });
  }

  private waitForCapacity(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        },
        reject: (error: unknown) => {
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      };
      const abort = () => {
        const index = this.producers.indexOf(waiter);
        if (index >= 0) this.producers.splice(index, 1);
        reject(new DOMException("aborted", "AbortError"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.producers.push(waiter);
    });
  }
}
