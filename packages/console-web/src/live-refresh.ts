export interface LiveRefreshOptions {
  readonly minimum_interval_ms?: number;
  readonly jitter_ratio?: number;
  readonly random?: () => number;
}

export class LiveRefresh {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private running = false;
  private pending = false;
  private refresh: ((signal: AbortSignal) => Promise<void>) | null = null;
  private readonly interval: number;
  private readonly jitter: number;
  private readonly random: () => number;

  constructor(options: LiveRefreshOptions = {}) {
    this.interval = options.minimum_interval_ms ?? 15_000;
    this.jitter = options.jitter_ratio ?? 0.15;
    this.random = options.random ?? Math.random;
    if (this.interval < 1_000 || this.interval > 300_000) throw new RangeError("refresh interval is invalid");
    if (this.jitter < 0 || this.jitter > 0.5) throw new RangeError("refresh jitter is invalid");
  }

  start(refresh: (signal: AbortSignal) => Promise<void>): void {
    if (this.running) return;
    this.running = true;
    this.refresh = refresh;
    this.schedule(0);
  }

  private schedule(delay: number): void {
    if (!this.running) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.turn(); }, delay);
  }

  private async turn(): Promise<void> {
      this.timer = null;
      if (!this.running || this.controller !== null) return;
      this.controller = new AbortController();
      try { await this.refresh?.(this.controller.signal); } catch { /* visible load state owns errors */ }
      finally { this.controller = null; }
      if (!this.running) return;
      if (this.pending) {
        this.pending = false;
        this.schedule(0);
        return;
      }
      const factor = 1 + (this.random() * 2 - 1) * this.jitter;
      this.schedule(Math.round(this.interval * factor));
  }

  invalidate(): void {
    if (!this.running) return;
    if (this.controller !== null) {
      this.pending = true;
      return;
    }
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.controller?.abort();
    this.timer = null;
    this.controller = null;
    this.pending = false;
    this.refresh = null;
  }
}

export async function consumeInvalidations(
  stream: AsyncIterable<unknown>,
  refresh: Pick<LiveRefresh, "invalidate">,
): Promise<void> {
  for await (const _delivery of stream) refresh.invalidate();
}
