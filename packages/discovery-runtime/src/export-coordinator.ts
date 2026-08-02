export interface DiscoveryExportCoordinatorOptions {
  readonly coalescing_window_ms: number;
  readonly schedule: (delayMs: number, callback: () => void) => void;
  readonly refresh: () => Promise<void>;
}

export class DiscoveryExportCoordinator {
  private scheduled = false;
  private running = false;
  private dirty = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly options: DiscoveryExportCoordinatorOptions) {
    if (!Number.isSafeInteger(options.coalescing_window_ms) || options.coalescing_window_ms < 1) {
      throw new RangeError("coalescing_window_ms must be positive");
    }
  }

  requestRefresh(): void {
    if (this.running) {
      this.dirty = true;
      return;
    }
    if (this.scheduled) return;
    this.scheduled = true;
    this.options.schedule(this.options.coalescing_window_ms, () => {
      this.scheduled = false;
      this.tail = this.run();
    });
  }

  idle(): Promise<void> {
    return this.tail;
  }

  private async run(): Promise<void> {
    this.running = true;
    try {
      await this.options.refresh();
    } finally {
      this.running = false;
      if (this.dirty) {
        this.dirty = false;
        this.requestRefresh();
      }
    }
  }
}
