export interface LocalMechanicalPumpOptions {
  readonly poll_interval_ms: number;
  readonly max_work_keys: number;
  readonly turn_limit: number;
  readonly turn: (workKey: string, limit: number) => Promise<void>;
}

export class LocalMechanicalPump {
  private readonly keys = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<void> | null = null;
  private running = false;
  constructor(private readonly options: LocalMechanicalPumpOptions) {
    for (const [field, value, maximum] of [["poll_interval_ms", options.poll_interval_ms, 60_000], ["max_work_keys", options.max_work_keys, 100_000], ["turn_limit", options.turn_limit, 10_000]] as const) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new RangeError(`${field} is outside its bound`);
    }
  }
  wake(workKey: string): void {
    if (typeof workKey !== "string" || workKey.length === 0 || workKey.length > 255) throw new TypeError("work key is invalid");
    if (!this.keys.has(workKey) && this.keys.size >= this.options.max_work_keys) throw new Error("mechanical pump capacity exceeded");
    this.keys.add(workKey);
  }
  start(): void { if (this.running) return; this.running = true; this.schedule(0); }
  private schedule(delay: number): void { if (!this.running) return; this.timer = setTimeout(() => { this.active = this.runCycle().finally(() => { this.active = null; this.schedule(this.options.poll_interval_ms); }); }, delay); }
  private async runCycle(): Promise<void> { for (const key of this.keys) { if (!this.running) break; try { await this.options.turn(key, this.options.turn_limit); } catch { /* one turn cannot block peers */ } } }
  async stop(): Promise<void> { this.running = false; if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined; await this.active; }
}
