export interface FeishuSdkLogSink {
  error(code: string): void;
  warn(code: string): void;
  info(code: string): void;
}

export function createFeishuSdkLogger(sink: FeishuSdkLogSink): {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  trace(...args: unknown[]): void;
} {
  return {
    error: (..._args: unknown[]) => sink.error("feishu_sdk_error"),
    warn: (..._args: unknown[]) => sink.warn("feishu_sdk_warning"),
    info: (..._args: unknown[]) => sink.info("feishu_sdk_info"),
    debug: (..._args: unknown[]) => undefined,
    trace: (..._args: unknown[]) => undefined,
  };
}
