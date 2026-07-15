import Fastify, { type FastifyError, type FastifyInstance } from "fastify";

import type { HttpServiceConfig } from "../config.js";
import { createProblemDetails } from "../problem-details.js";
import type { HttpRequestAuthenticator } from "../public-types.js";
import type { AuthorityPolicy, IdentityProvider, SubscriptionStore } from "@work-fabric/exchange-spi";
import type { ExchangeQueryService } from "../query-service.js";
import type { WfppSchemaValidator } from "@work-fabric/protocol-runtime";
import type { HealthProbe, HealthService } from "../health-service.js";
import type { SseConnectionManager } from "../sse-connection-manager.js";
import { registerHealthRoutes } from "../routes/health-routes.js";
import { registerSseRoute } from "../routes/sse-route.js";
import { registerAdminRoutes } from "../routes/admin-routes.js";
import { registerQueryRoutes } from "../routes/query-routes.js";
import { registerSubscriptionResourceRoutes } from "../routes/subscription-resource-routes.js";
import {
  registerDeliveryRoutes,
  type DurableDeliveryService,
} from "../routes/delivery-routes.js";
import {
  registerCommandRoute,
  type CommandApplication,
} from "../routes/command-route.js";

export interface InternalServerDependencies {
  readonly application: CommandApplication;
  readonly authenticator: HttpRequestAuthenticator;
  readonly query?: ExchangeQueryService;
  readonly identity?: IdentityProvider;
  readonly authority?: AuthorityPolicy;
  readonly subscriptions?: SubscriptionStore;
  readonly schemas?: WfppSchemaValidator;
  readonly delivery?: DurableDeliveryService;
  readonly health_probes?: readonly HealthProbe[];
  readonly health?: HealthService;
  readonly sse_connections?: SseConnectionManager;
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
  if (dependencies.health !== undefined) {
    registerHealthRoutes(server, {
      health: dependencies.health,
      authenticator: dependencies.authenticator,
      ...(dependencies.identity === undefined ? {} : { identity: dependencies.identity }),
      ...(dependencies.authority === undefined ? {} : { authority: dependencies.authority }),
    });
  }
  if (dependencies.identity !== undefined && dependencies.authority !== undefined) {
    if (dependencies.delivery !== undefined) {
      registerDeliveryRoutes(server, {
        delivery: dependencies.delivery, identity: dependencies.identity,
        authority: dependencies.authority, authenticator: dependencies.authenticator,
      }, config);
      if (dependencies.sse_connections !== undefined) {
        registerSseRoute(server, {
          delivery: dependencies.delivery, identity: dependencies.identity,
          authority: dependencies.authority, authenticator: dependencies.authenticator,
          connections: dependencies.sse_connections,
        }, config);
      }
    }
    if (dependencies.query !== undefined) {
      registerQueryRoutes(server, {
        query: dependencies.query, identity: dependencies.identity,
        authority: dependencies.authority, authenticator: dependencies.authenticator,
      }, config);
      registerAdminRoutes(server, {
        query: dependencies.query, identity: dependencies.identity,
        authority: dependencies.authority, authenticator: dependencies.authenticator,
      }, config);
      if (dependencies.subscriptions !== undefined && dependencies.schemas !== undefined) {
        registerSubscriptionResourceRoutes(server, {
          query: dependencies.query, subscriptions: dependencies.subscriptions,
          schemas: dependencies.schemas, identity: dependencies.identity,
          authority: dependencies.authority, authenticator: dependencies.authenticator,
        });
      }
    }
  }
  return server;
}
