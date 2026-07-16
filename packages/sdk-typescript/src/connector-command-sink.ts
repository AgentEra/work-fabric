import type {
  ConnectorCommandExecution,
  ConnectorCommandResult,
  ConnectorCommandSink,
} from "@work-fabric/connector-spi";
import type { JsonObject } from "@work-fabric/exchange-spi";

import type { WorkFabricClient } from "./client.js";
import type { OperationResult } from "./protocol-types.js";

const SUPPORTED = new Set([
  "handoff.accept",
  "handoff.decline",
  "handoff.expire",
  "handoff.cancel",
  "handoff.report_status",
  "handoff.return_result",
  "handoff.verify",
  "handoff.close",
  "handoff.request_rework",
]);

function detail(result: OperationResult): string | undefined {
  const code = result.error?.code;
  return typeof code === "string" ? code.slice(0, 256) : undefined;
}

function classify(result: OperationResult): ConnectorCommandResult {
  if (result.operation_status === "accepted") {
    const value = result.receipt?.receipt_id;
    return {
      kind: "accepted",
      receipt_id:
        typeof value === "string"
          ? value
          : `operation:${result.request_message_id}`,
      event_ids: [],
    };
  }
  const errorDetail = detail(result);
  return {
    kind:
      result.operation_status === "temporarily_unavailable"
        ? "retryable_failure"
        : "permanent_failure",
    error_code: `work_fabric_${result.operation_status}`,
    ...(errorDetail === undefined ? {} : { detail: errorDetail }),
  };
}

function handoffId(input: JsonObject): string {
  const value = input.handoff_id;
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new TypeError("handoff_id is invalid");
  }
  return value;
}

export class ConnectorSdkCommandSink implements ConnectorCommandSink {
  readonly manifest = {
    profile: "connector.command-sink.v1",
    adapter: "work-fabric-typescript-sdk",
    capabilities: {
      public_sdk_only: true,
      representation_binding: true,
      outcome_classification: true,
    },
  } as const;

  constructor(private readonly client: WorkFabricClient) {}

  async execute(
    execution: ConnectorCommandExecution,
  ): Promise<ConnectorCommandResult> {
    const { command } = execution;
    if (
      !SUPPORTED.has(command.operation) ||
      command.identity.endpoint_id === undefined ||
      command.expected_version === undefined
    ) {
      return {
        kind: "permanent_failure",
        error_code: "unsupported_or_incomplete_command",
      };
    }
    try {
      const handoffs = this.client.withRepresentation({
        actorId: command.identity.actor_id,
        endpointId: command.identity.endpoint_id,
        ...(command.identity.delegation_id === undefined
          ? {}
          : { delegationId: command.identity.delegation_id }),
      }).handoffs;
      const options = {
        expectedVersion: command.expected_version,
        idempotencyKey: command.idempotency_key,
        correlationId: execution.ingress_id,
      };
      const id = handoffId(command.input);
      let result: OperationResult;
      switch (command.operation) {
        case "handoff.accept":
          result = await handoffs.accept({ handoff_id: id }, options);
          break;
        case "handoff.decline":
          result = await handoffs.decline({ handoff_id: id }, options);
          break;
        case "handoff.expire":
          result = await handoffs.expire({ handoff_id: id }, options);
          break;
        case "handoff.close":
          result = await handoffs.close({ handoff_id: id }, options);
          break;
        case "handoff.cancel":
          result = await handoffs.cancel(command.input as never, options);
          break;
        case "handoff.report_status":
          result = await handoffs.reportStatus(command.input as never, options);
          break;
        case "handoff.return_result":
          result = await handoffs.returnResult(command.input as never, options);
          break;
        case "handoff.verify":
          result = await handoffs.verify(command.input as never, options);
          break;
        case "handoff.request_rework":
          result = await handoffs.requestRework(command.input as never, options);
          break;
        default:
          return {
            kind: "permanent_failure",
            error_code: "unsupported_operation",
          };
      }
      return classify(result);
    } catch (error) {
      return error instanceof TypeError
        ? {
            kind: "permanent_failure",
            error_code: "invalid_command",
          }
        : {
            kind: "retryable_failure",
            error_code: "sdk_transport_failure",
          };
    }
  }
}
