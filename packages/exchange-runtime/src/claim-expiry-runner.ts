import type {
  EndpointExpiredClaim,
  EndpointInboxStore,
} from "@work-fabric/exchange-spi";

export type ClaimExpiryAttempt = "expired" | "stale" | "retry";

export interface ClaimExpiryRunResult {
  readonly inspected: number;
  readonly expired: number;
  readonly stale: number;
  readonly retry: number;
}

export interface ClaimLeaseExpiryRunnerOptions {
  readonly tenant_id: string;
  readonly inbox: EndpointInboxStore;
  readonly clock: { now(): string };
  readonly expire: (claim: EndpointExpiredClaim) => Promise<ClaimExpiryAttempt>;
  readonly poll_interval_ms: number;
  readonly page_limit: number;
  readonly max_pages_per_run: number;
}

function positiveBounded(
  value: number,
  field: string,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${field} is outside its bound`);
  }
}

export class ClaimLeaseExpiryRunner {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<void> | null = null;
  private running = false;

  constructor(private readonly options: ClaimLeaseExpiryRunnerOptions) {
    if (options.tenant_id.length === 0) {
      throw new TypeError("tenant_id must not be empty");
    }
    positiveBounded(options.poll_interval_ms, "poll_interval_ms", 60_000);
    positiveBounded(options.page_limit, "page_limit", 1_000);
    positiveBounded(options.max_pages_per_run, "max_pages_per_run", 1_000);
  }

  async runOnce(): Promise<ClaimExpiryRunResult> {
    const deadline = this.options.clock.now();
    let cursor: string | undefined;
    let inspected = 0;
    let expired = 0;
    let stale = 0;
    let retry = 0;
    for (let pageNumber = 0; pageNumber < this.options.max_pages_per_run; pageNumber += 1) {
      const page = await this.options.inbox.listExpiredClaims({
        tenant_id: this.options.tenant_id,
        expires_at_or_before: deadline,
        ...(cursor === undefined ? {} : { cursor }),
        limit: this.options.page_limit,
      });
      for (const claim of page.items) {
        inspected += 1;
        try {
          const result = await this.options.expire(claim);
          if (result === "expired") expired += 1;
          else if (result === "stale") stale += 1;
          else retry += 1;
        } catch {
          retry += 1;
        }
      }
      if (page.next_cursor === undefined) break;
      cursor = page.next_cursor;
    }
    return { inspected, expired, stale, retry };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.active;
  }

  private schedule(delay: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.active = this.runOnce()
        .then(() => undefined, () => undefined)
        .finally(() => {
          this.active = null;
          this.schedule(this.options.poll_interval_ms);
        });
    }, delay);
  }
}
