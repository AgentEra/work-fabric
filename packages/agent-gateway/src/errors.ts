export type AgentGatewayErrorCode =
  | "invalid_config"
  | "subscription_mismatch"
  | "partition_limit_exceeded"
  | "connection_failed";

export class AgentGatewayError extends Error {
  constructor(
    readonly code: AgentGatewayErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentGatewayError";
  }
}
