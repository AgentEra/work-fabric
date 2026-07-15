import type { RepresentationContext } from "./config.js";
import type { CommandEnvelope, OperationResult } from "./protocol-types.js";
import type { SdkTransport } from "./transport.js";

export interface CommandSendOptions {
  readonly signal?: AbortSignal;
  readonly representation?: RepresentationContext;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeOperationResult(value: unknown): OperationResult {
  if (!isObject(value)) throw new TypeError("OperationResult must be an object");
  const status = value.operation_status;
  if (
    value.spec_version !== "1.0" ||
    typeof value.request_message_id !== "string" ||
    (status !== "accepted" &&
      status !== "rejected" &&
      status !== "conflict" &&
      status !== "temporarily_unavailable") ||
    (value.resource !== null && !isObject(value.resource)) ||
    (value.receipt !== null && !isObject(value.receipt)) ||
    (value.error !== null && !isObject(value.error))
  ) {
    throw new TypeError("OperationResult is invalid");
  }
  return value as unknown as OperationResult;
}

export class CommandClient {
  constructor(private readonly transport: SdkTransport) {}

  send(
    envelope: CommandEnvelope,
    options: CommandSendOptions = {},
  ): Promise<OperationResult> {
    return this.transport.request({
      method: "POST",
      path: ["v1", "commands"],
      body: envelope,
      retry: "none",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.representation === undefined
        ? {}
        : { representation: options.representation }),
      decode: decodeOperationResult,
      decodeError: decodeOperationResult,
    });
  }
}
