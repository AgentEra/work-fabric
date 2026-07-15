import Fastify, { type FastifyError, type FastifyInstance } from "fastify";

import type { HttpServiceConfig } from "../config.js";
import { createProblemDetails } from "../problem-details.js";
import type { HttpRequestAuthenticator } from "../public-types.js";
import {
  registerCommandRoute,
  type CommandApplication,
} from "../routes/command-route.js";

export interface InternalServerDependencies {
  readonly application: CommandApplication;
  readonly authenticator: HttpRequestAuthenticator;
}

export function createInternalServer(
  dependencies: InternalServerDependencies,
  config: HttpServiceConfig,
): FastifyInstance {
  const server = Fastify({
    bodyLimit: config.body_limit_bytes,
    requestTimeout: config.request_timeout_ms,
    logger: false,
  });
  server.setErrorHandler((error: FastifyError, request, reply) => {
    const status =
      error.statusCode === 413
        ? 413
        : error.statusCode === 415
          ? 415
          : error.statusCode === 400
            ? 400
            : 500;
    const code =
      status === 413
        ? "payload_too_large"
        : status === 415
          ? "unsupported_media_type"
          : status === 400
            ? "invalid_request"
            : "internal_error";
    const title =
      status === 413
        ? "Payload too large"
        : status === 415
          ? "Unsupported media type"
          : status === 400
            ? "Invalid request"
            : "Internal server error";
    reply
      .header("x-request-id", request.id)
      .type("application/problem+json")
      .code(status)
      .send(createProblemDetails(status, code, title, { instance: request.url }));
  });
  registerCommandRoute(server, dependencies.application, dependencies.authenticator);
  return server;
}
