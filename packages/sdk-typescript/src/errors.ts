export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: string;
  readonly instance?: string;
}

export type TransportErrorCode =
  | "network_error"
  | "timeout"
  | "aborted"
  | "redirect_rejected"
  | "invalid_response"
  | "stream_protocol_error"
  | "stream_reconnect_exhausted";

export class WorkFabricHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly problem: ProblemDetails;

  constructor(problem: ProblemDetails, requestId: string | null) {
    super(problem.title);
    this.name = "WorkFabricHttpError";
    this.status = problem.status;
    this.code = problem.code;
    this.requestId = requestId;
    this.problem = Object.freeze({ ...problem });
  }
}

export class WorkFabricTransportError extends Error {
  readonly code: TransportErrorCode;
  readonly requestId: string | null;

  constructor(
    code: TransportErrorCode,
    message: string,
    requestId: string | null = null,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "WorkFabricTransportError";
    this.code = code;
    this.requestId = requestId;
  }
}

