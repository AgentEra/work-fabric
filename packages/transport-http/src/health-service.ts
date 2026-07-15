export type DependencyHealthStatus = "healthy" | "unhealthy";

export interface HealthProbe {
  readonly dependency_id: string;
  check(signal: AbortSignal): Promise<DependencyHealthStatus>;
}

export interface DependencyHealth {
  readonly dependency_id: string;
  readonly status: DependencyHealthStatus;
  readonly observed_at: string;
  readonly latency_ms: number;
}

export interface HealthReport {
  readonly status: "ready" | "not_ready";
  readonly dependencies: readonly DependencyHealth[];
}

function boundedDependencyId(value: string): string {
  if (value.length === 0 || value.length > 128) {
    throw new TypeError("dependency_id must contain 1 to 128 characters");
  }
  return value;
}

export class HealthService {
  private shuttingDown = false;

  constructor(
    private readonly probes: readonly HealthProbe[],
    private readonly timeoutMs: number,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError("health probe timeout must be a positive safe integer");
    }
    const ids = new Set<string>();
    for (const probe of probes) {
      const id = boundedDependencyId(probe.dependency_id);
      if (ids.has(id)) throw new TypeError("dependency_id must be unique");
      ids.add(id);
    }
  }

  beginShutdown(): void {
    this.shuttingDown = true;
  }

  async report(): Promise<HealthReport> {
    if (this.shuttingDown) {
      return { status: "not_ready", dependencies: [] };
    }
    const dependencies = await Promise.all(
      this.probes.map((probe) => this.check(probe)),
    );
    return {
      status: dependencies.every(({ status }) => status === "healthy")
        ? "ready"
        : "not_ready",
      dependencies,
    };
  }

  private async check(probe: HealthProbe): Promise<DependencyHealth> {
    const started = performance.now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<DependencyHealthStatus>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve("unhealthy");
      }, this.timeoutMs);
    });
    let status: DependencyHealthStatus;
    try {
      status = await Promise.race([
        Promise.resolve(probe.check(controller.signal)).then((value) =>
          value === "healthy" ? "healthy" as const : "unhealthy" as const,
        ),
        timedOut,
      ]);
    } catch {
      status = "unhealthy";
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    return {
      dependency_id: probe.dependency_id,
      status,
      observed_at: new Date().toISOString(),
      latency_ms: Math.max(0, Math.round(performance.now() - started)),
    };
  }
}
