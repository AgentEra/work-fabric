export class ConnectorWorkerError extends Error {
  constructor(
    readonly code: string,
    readonly safe_detail: string | undefined,
    readonly retryable: boolean,
  ) {
    super(code);
  }
}

export class RetryableConnectorError extends ConnectorWorkerError {
  constructor(code: string, safeDetail?: string) {
    super(code, safeDetail, true);
  }
}

export class PermanentConnectorError extends ConnectorWorkerError {
  constructor(code: string, safeDetail?: string) {
    super(code, safeDetail, false);
  }
}
