import type {
  HandoffReadModel,
  RequestOptions,
} from "@work-fabric/sdk-typescript";
import type { RuntimeJsonObject } from "@work-fabric/agent-runtime-spi";

import type {
  AuxiliaryHandoffTerminal,
  AuxiliaryHandoffWaiter,
  BoundAuxiliaryHandoff,
} from "./contracts.js";

export interface PollingAuxiliaryHandoffWaiterOptions {
  readonly queries: {
    getHandoff(
      handoffId: string,
      options?: RequestOptions,
    ): Promise<HandoffReadModel>;
  };
  readonly poll_interval_ms?: number;
  readonly now?: () => string;
  readonly delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

function object(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;

function exactOutcome(
  value: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const keys = Object.keys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => !fields.includes(key)) ||
    fields.some((field) => !Object.hasOwn(value, field))
  ) throw new TypeError("Capability Provider outcome fields are invalid");
  return value;
}

function leapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function validRfc3339(value: string): boolean {
  const match = RFC3339.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[7] ?? 0);
  const offsetMinute = Number(match[8] ?? 0);
  const days = [
    31,
    leapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return year >= 1 &&
    month >= 1 && month <= 12 &&
    day >= 1 && day <= days[month - 1]! &&
    hour <= 23 && minute <= 59 && second <= 59 &&
    offsetHour <= 23 && offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value));
}

function retryAfter(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !validRfc3339(value)
  ) throw new TypeError("Capability Provider failure retry_after is invalid");
  return value;
}

function providerOutcome(snapshot: HandoffReadModel): AuxiliaryHandoffTerminal {
  const state = object(snapshot.state);
  const result = object(state?.result);
  const summary = result?.summary;
  if (!Array.isArray(summary) || summary.length !== 1) {
    throw new TypeError("Capability Provider Result summary is invalid");
  }
  const content = object(summary[0]);
  const outcome = object(content?.data);
  if (
    content?.kind !== "data" ||
    content.schema_ref !== "urn:work-fabric:schema:capability-result:1" ||
    outcome === null
  ) throw new TypeError("Capability Provider Result content is invalid");
  if (outcome.outcome === "succeeded") {
    const succeeded = exactOutcome(outcome, ["outcome", "data", "artifacts"]);
    const data = object(succeeded.data);
    if (data === null || !Array.isArray(succeeded.artifacts)) {
      throw new TypeError("Capability Provider success is invalid");
    }
    return {
      outcome: "succeeded",
      data: data as RuntimeJsonObject,
      artifacts: succeeded.artifacts as readonly RuntimeJsonObject[],
    };
  }
  if (outcome.outcome === "rejected" || outcome.outcome === "failed") {
    const hasRetryAfter = Object.hasOwn(outcome, "retry_after");
    const failure = exactOutcome(outcome, [
      "outcome",
      "code",
      "message",
      "retryable",
      ...(hasRetryAfter ? ["retry_after"] : []),
    ]);
    if (
      typeof failure.code !== "string" ||
      typeof failure.message !== "string" ||
      typeof failure.retryable !== "boolean"
    ) throw new TypeError("Capability Provider failure is invalid");
    if (
      hasRetryAfter &&
      (failure.outcome !== "failed" || failure.retryable !== true)
    ) throw new TypeError("Capability Provider failure retry_after is invalid");
    const retry_after = retryAfter(failure.retry_after);
    return {
      outcome: outcome.outcome,
      code: failure.code,
      message: failure.message,
      retryable: failure.retryable,
      ...(retry_after === undefined ? {} : { retry_after }),
    };
  }
  throw new TypeError("Capability Provider outcome is invalid");
}

function defaultDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true });
  });
}

export class PollingAuxiliaryHandoffWaiter
  implements AuxiliaryHandoffWaiter {
  private readonly interval: number;
  private readonly now: () => string;
  private readonly delay: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>;

  constructor(private readonly options: PollingAuxiliaryHandoffWaiterOptions) {
    this.interval = options.poll_interval_ms ?? 250;
    if (
      !Number.isSafeInteger(this.interval) ||
      this.interval < 1 ||
      this.interval > 30_000
    ) throw new RangeError("Capability polling interval is invalid");
    this.now = options.now ?? (() => new Date().toISOString());
    this.delay = options.delay ?? defaultDelay;
  }

  async wait(
    input: BoundAuxiliaryHandoff,
    signal: AbortSignal,
  ): Promise<AuxiliaryHandoffTerminal> {
    for (;;) {
      if (signal.aborted) {
        return {
          outcome: "failed",
          code: "capability_cancelled",
          message: "Capability invocation was cancelled",
          retryable: false,
        };
      }
      if (this.now() >= input.deadline) {
        return {
          outcome: "failed",
          code: "capability_deadline_exceeded",
          message: "Capability invocation deadline has elapsed",
          retryable: false,
        };
      }
      const snapshot = await this.options.queries.getHandoff(
        input.auxiliary_handoff_id,
        { signal },
      );
      const state = object(snapshot.state);
      const lifecycle = state?.lifecycle_state;
      if (lifecycle === "result_returned" || lifecycle === "verified" ||
          lifecycle === "closed") {
        return providerOutcome(snapshot);
      }
      if (
        lifecycle === "declined" ||
        lifecycle === "target_unavailable" ||
        lifecycle === "expired" ||
        lifecycle === "cancelled" ||
        lifecycle === "transferred"
      ) {
        return {
          outcome: "failed",
          code: `capability_handoff_${String(lifecycle)}`,
          message: "Capability Provider Handoff ended without a Result",
          retryable: lifecycle === "target_unavailable",
        };
      }
      await this.delay(this.interval, signal);
    }
  }
}
