import type { FastifyInstance } from "fastify";

import type {
  CommandEnvelope,
  OperationResult,
} from "@work-fabric/exchange-core";
import type { JsonObject } from "@work-fabric/exchange-spi";

import { operationResultStatus } from "../operation-result-http.js";
import type { HttpRequestAuthenticator } from "../public-types.js";
import { createProblemDetails } from "../problem-details.js";

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
      return reply.code(operationResultStatus(result)).send(result);
    } catch {
      const result = temporaryFailure(requestMessageId);
      return reply.code(503).send(result);
    }
  });
}
