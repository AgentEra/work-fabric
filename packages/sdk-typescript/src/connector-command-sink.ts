import type {
  ConnectorCommandExecution,
  ConnectorCommandResult,
  ConnectorCommandSink,
} from "@work-fabric/connector-spi";
import type { JsonObject } from "@work-fabric/exchange-spi";

import type { WorkFabricClient } from "./client.js";
import type { OperationResult } from "./protocol-types.js";
import { BearerTokenProvider } from "./authentication.js";

const SUPPORTED = new Set([
  "handoff.offer",
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

function detail(
  result: OperationResult,
  protectedValue: string | undefined,
): string | undefined {
  const code = result.error?.code;
  return typeof code === "string" &&
    (protectedValue === undefined || !code.includes(protectedValue))
    ? code.slice(0, 256)
    : undefined;
}

function classify(
  result: OperationResult,
  protectedValue?: string,
): ConnectorCommandResult {
  if (result.operation_status === "accepted") {
    const value = result.receipt?.receipt_id;
    const resource = result.resource;
    const acceptedResource =
      resource !== null &&
      resource.resource_type === "handoff" &&
      typeof resource.resource_id === "string" &&
      resource.resource_id.length > 0 &&
      resource.resource_id.length <= 128 &&
      Number.isSafeInteger(resource.resource_version) &&
      (resource.resource_version as number) > 0
        ? {
            resource_type: "handoff" as const,
            resource_id: resource.resource_id,
            resource_version: resource.resource_version as number,
          }
        : undefined;
    return {
      kind: "accepted",
      receipt_id:
        typeof value === "string"
          ? value
          : `operation:${result.request_message_id}`,
      event_ids: [],
      ...(acceptedResource === undefined ? {} : { resource: acceptedResource }),
    };
  }
  const errorDetail = detail(result, protectedValue);
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

function commandBearerCredential(authentication: unknown): string | undefined {
  if (authentication === undefined) return undefined;
  if (
    authentication === null ||
    typeof authentication !== "object" ||
    Array.isArray(authentication)
  ) {
    throw new TypeError("Command authentication is invalid");
  }
  const keys = Reflect.ownKeys(authentication);
  if (
    keys.length !== 2 ||
    !keys.includes("kind") ||
    !keys.includes("credential")
  ) {
    throw new TypeError("Command authentication is invalid");
  }
  const kind = Object.getOwnPropertyDescriptor(authentication, "kind");
  const credential = Object.getOwnPropertyDescriptor(authentication, "credential");
  if (
    kind === undefined ||
    credential === undefined ||
    !("value" in kind) ||
    !("value" in credential) ||
    kind.value !== "bearer" ||
    typeof credential.value !== "string"
  ) {
    throw new TypeError("Command authentication is invalid");
  }
  return credential.value;
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
      (command.operation !== "handoff.offer" && command.expected_version === undefined) ||
      (command.operation === "handoff.offer" && command.expected_version !== undefined)
    ) {
      return {
        kind: "permanent_failure",
        error_code: "unsupported_or_incomplete_command",
      };
    }
    try {
      const credential = commandBearerCredential(command.authentication);
      let client = this.client;
      if (credential !== undefined) {
        const authentication = new BearerTokenProvider(credential);
        await authentication.getAuthorization({
          method: "POST",
          url: "https://command-authentication.invalid",
          signal: new AbortController().signal,
        });
        client = this.client.withAuthentication(authentication);
      }
      const handoffs = client.withRepresentation({
        actorId: command.identity.actor_id,
        endpointId: command.identity.endpoint_id,
        ...(command.identity.delegation_id === undefined
          ? {}
          : { delegationId: command.identity.delegation_id }),
      }).handoffs;
      const options = {
        expectedVersion: command.expected_version!,
        idempotencyKey: command.idempotency_key,
        correlationId: execution.ingress_id,
      };
      let result: OperationResult;
      switch (command.operation) {
        case "handoff.offer":
          result = await handoffs.offer(command.input as never, {
            idempotencyKey: command.idempotency_key,
            correlationId: execution.ingress_id,
          });
          break;
        case "handoff.accept":
          result = await handoffs.accept({ handoff_id: handoffId(command.input) }, options);
          break;
        case "handoff.decline":
          result = await handoffs.decline({ handoff_id: handoffId(command.input) }, options);
          break;
        case "handoff.expire":
          result = await handoffs.expire({ handoff_id: handoffId(command.input) }, options);
          break;
        case "handoff.close":
          result = await handoffs.close({ handoff_id: handoffId(command.input) }, options);
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
      return classify(result, credential);
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
