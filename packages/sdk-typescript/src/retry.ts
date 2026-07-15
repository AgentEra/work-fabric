import type { QueryRetryPolicy } from "./config.js";

export type Sleep = (
  milliseconds: number,
  signal?: AbortSignal,
) => Promise<void>;

export const abortableSleep: Sleep = async (milliseconds, signal) => {
  if (signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
    }
  });
};

export function retryDelay(
  retryIndex: number,
  policy: QueryRetryPolicy,
  random: () => number,
  retryAfter: string | null,
  now = Date.now(),
): number {
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    const parsed = Number.isFinite(seconds)
      ? Math.max(0, seconds * 1_000)
      : Math.max(0, Date.parse(retryAfter) - now);
    if (Number.isFinite(parsed)) {
      return Math.min(parsed, policy.maxRetryAfterMs);
    }
  }
  const ceiling = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * 2 ** retryIndex,
  );
  return Math.max(0, Math.round(ceiling * Math.min(1, Math.max(0, random()))));
}
