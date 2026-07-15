export interface LinkedAbortSignal {
  readonly signal: AbortSignal;
  readonly didTimeout: () => boolean;
  readonly clearTimeout: () => void;
  readonly cleanup: () => void;
}

export function linkedAbortSignal(
  external: AbortSignal | undefined,
  timeoutMs: number,
): LinkedAbortSignal {
  const controller = new AbortController();
  let timedOut = false;

  const abortFromExternal = () => controller.abort(external?.reason);
  if (external?.aborted) {
    abortFromExternal();
  } else {
    external?.addEventListener("abort", abortFromExternal, { once: true });
  }

  let timeout: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("request timed out", "TimeoutError"));
  }, timeoutMs);

  const clearRequestTimeout = () => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
      timeout = undefined;
    }
  };

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    clearTimeout: clearRequestTimeout,
    cleanup() {
      clearRequestTimeout();
      external?.removeEventListener("abort", abortFromExternal);
    },
  };
}

export function isAbortError(value: unknown): boolean {
  return (
    (value instanceof DOMException && value.name === "AbortError") ||
    (value instanceof Error && value.name === "AbortError")
  );
}
