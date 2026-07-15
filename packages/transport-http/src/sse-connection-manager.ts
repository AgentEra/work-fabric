export interface SseConnectionLease {
  readonly signal: AbortSignal;
  release(): void;
}

export class SseConnectionManager {
  private readonly controllers = new Set<AbortController>();
  private shuttingDown = false;

  constructor(private readonly maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum <= 0) {
      throw new TypeError("SSE connection maximum must be a positive safe integer");
    }
  }

  acquire(): SseConnectionLease | null {
    if (this.shuttingDown || this.controllers.size >= this.maximum) return null;
    const controller = new AbortController();
    this.controllers.add(controller);
    let released = false;
    return {
      signal: controller.signal,
      release: () => {
        if (released) return;
        released = true;
        this.controllers.delete(controller);
        controller.abort();
      },
    };
  }

  beginShutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }
}
