import type { FastifyInstance } from "fastify";

import type {
  CommandEnvelope,
  OperationResult,
} from "@work-fabric/exchange-core";
import type { JsonObject } from "@work-fabric/exchange-spi";
import type { IdentityProvider } from "@work-fabric/exchange-spi";
import type { OperationAuditRecorder } from "@work-fabric/operations-runtime";

import { operationResultStatus } from "../operation-result-http.js";
import type { HttpRequestAuthenticator } from "../public-types.js";
import { createProblemDetails } from "../problem-details.js";
import { requestTraceId } from "./route-authorization.js";

export interface CommandApplication {
  handle(
    envelope: CommandEnvelope,
    authenticationEvidence: JsonObject,
  ): Promise<OperationResult>;
}

function temporaryFailure(requestMessageId: string): OperationResult {
  return {
    spec_version: "1.0",
    request_message_id: requestMessageId,
    operation_status: "temporarily_unavailable",
    resource: null,
    receipt: null,
    error: {
      code: "temporarily_unavailable",
      message: "The Exchange is temporarily unavailable",
      retryable: true,
    },
  };
}

export function registerCommandRoute(
  server: FastifyInstance,
  application: CommandApplication,
  authenticator: HttpRequestAuthenticator,
  auditDependencies: {
    readonly identity?: IdentityProvider;
    readonly audit?: OperationAuditRecorder;
  } = {},
): void {
  server.post("/v1/commands", async (request, reply) => {
    reply.header("x-request-id", request.id);
    const contentType = request.headers["content-type"];
    if (
      typeof contentType !== "string" ||
      !/^application\/json(?:\s*;|$)/i.test(contentType)
    ) {
      return reply
        .type("application/problem+json")
        .code(415)
        .send(
          createProblemDetails(
            415,
            "unsupported_media_type",
            "Unsupported media type",
            { instance: request.url },
          ),
        );
    }
    const body = request.body as Partial<CommandEnvelope> | null;
    const requestMessageId =
      typeof body?.message_id === "string" ? body.message_id : request.id;
    try {
      const evidence = await authenticator.authenticationEvidence({
        authorization:
          typeof request.headers.authorization === "string"
            ? request.headers.authorization
            : null,
        request_id: request.id,
      });
      const result = await application.handle(
        request.body as CommandEnvelope,
        evidence ?? {},
      );
      const envelope = request.body as Partial<CommandEnvelope> | null;
      try {
        if (
          auditDependencies.audit !== undefined &&
          auditDependencies.identity !== undefined &&
          evidence !== null &&
          typeof envelope?.tenant_id === "string" &&
          typeof envelope.message_type === "string" &&
          typeof envelope.actor_id === "string" &&
          typeof envelope.endpoint_id === "string"
        ) {
          const principal = await auditDependencies.identity.resolve(evidence);
          const claim = principal?.tenant_id === envelope.tenant_id
            ? principal.actor_claims.find((candidate) =>
                candidate.actor_id === envelope.actor_id &&
                candidate.endpoint_ids.includes(envelope.endpoint_id as string),
              )
            : undefined;
          if (principal !== null && principal?.tenant_id === envelope.tenant_id) {
            const handoffId = typeof envelope.payload?.handoff_id === "string"
              ? envelope.payload.handoff_id
              : null;
            const errorCode = typeof result.error?.code === "string"
              ? result.error.code
              : null;
            auditDependencies.audit.stageHttp(request.id, {
              tenant_id: principal.tenant_id,
              trace_id: requestTraceId(request),
              principal_id: principal.principal_id,
              represented_actor: claim === undefined
                ? null
                : { actor_id: claim.actor_id, actor_type: claim.actor_type },
              represented_endpoint_id: claim === undefined ? null : envelope.endpoint_id,
              delegation_id: typeof envelope.delegation_id === "string"
                ? envelope.delegation_id
                : null,
              operation: envelope.message_type,
              resource_kind: handoffId === null ? "exchange" : "handoff",
              resource_id: handoffId ?? envelope.exchange_id ?? principal.tenant_id,
              authorization_decision:
                errorCode === "unauthenticated" || errorCode === "permission_denied"
                  ? "denied"
                  : "allowed",
            });
          }
        }
      } catch {
        // Observability must not change an already determined command outcome.
      }
      return reply.code(operationResultStatus(result)).send(result);
    } catch {
      const result = temporaryFailure(requestMessageId);
      return reply.code(503).send(result);
    }
  });
}
