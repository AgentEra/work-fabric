import { randomUUID } from "node:crypto";

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
import {
  registerEndpointRoutes,
} from "../routes/endpoint-routes.js";
import type { EndpointDirectoryService } from "@work-fabric/endpoint-directory";
import type { EndpointInboxQueryService } from "@work-fabric/exchange-runtime";
import type { FeishuWebhookDependencies } from "../public-types.js";
import { registerFeishuWebhookRoute } from "../routes/feishu-webhook-route.js";
import type { CollaborationQueryService, OperationsQueryService, RecoveryService } from "@work-fabric/operations-runtime";
import type { OperationAuditRecorder } from "@work-fabric/operations-runtime";
import { registerCollaborationRoutes } from "../routes/collaboration-routes.js";
import { bindRequestAudit } from "../routes/route-authorization.js";
import { registerOperationsRoutes } from "../routes/operations-routes.js";
import { registerRecoveryRoutes } from "../routes/recovery-routes.js";
import {
  observeSemanticSafely,
  safeSemanticCorrelationId,
  type SemanticObservation,
  type SemanticTelemetryObserver,
} from "@work-fabric/operations-spi";
import type { NetworkCitizenDirectoryService } from "@work-fabric/network-citizen-directory";
import { registerCitizenRoutes } from "../routes/citizen-routes.js";

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
  readonly endpoint_directory?: EndpointDirectoryService;
  readonly endpoint_inbox?: EndpointInboxQueryService;
  readonly citizen_directory?: NetworkCitizenDirectoryService;
  readonly feishu_webhook?: FeishuWebhookDependencies;
  readonly collaboration?: CollaborationQueryService;
  readonly audit?: OperationAuditRecorder;
  readonly operations?: OperationsQueryService;
  readonly recovery?: RecoveryService;
  readonly telemetry?: SemanticTelemetryObserver;
}

function httpOperation(method: string, url: string): SemanticObservation["operation"] {
  const path = url.split("?", 1)[0] ?? url;
  if (method === "POST" && path === "/v1/commands") return "command";
  if (path.startsWith("/v1/collaboration/")) return "collaboration_query";
  if (path.startsWith("/v1/operations/") || path.startsWith("/v1/admin/")) {
    return "operations_query";
  }
  return "http_request";
}

function httpOutcome(status: number): SemanticObservation["outcome"] {
  if (status < 400) return "succeeded";
  if (status === 401 || status === 403) return "denied";
  if (status === 409) return "conflicted";
  if (status === 429 || status >= 500) return "retryable";
  return "failed";
}

export function createInternalServer(
  dependencies: InternalServerDependencies,
  config: HttpServiceConfig,
): FastifyInstance {
  const server = Fastify({
    bodyLimit: config.body_limit_bytes,
    genReqId: () => `req-${randomUUID()}`,
    requestTimeout: config.request_timeout_ms,
    logger: false,
  });
  if (dependencies.telemetry !== undefined) {
    const requestStartedAt = new WeakMap<object, number>();
    server.addHook("onRequest", async (request) => {
      requestStartedAt.set(request, performance.now());
    });
    server.addHook("onResponse", async (request, reply) => {
      const startedAt = requestStartedAt.get(request) ?? performance.now();
      const correlationId = safeSemanticCorrelationId(request.id);
      observeSemanticSafely(dependencies.telemetry, {
        operation: httpOperation(request.method, request.url),
        outcome: httpOutcome(reply.statusCode),
        category: "http",
        duration_ms: Math.max(0, performance.now() - startedAt),
        count: 1,
        ...(correlationId === undefined ? {} : { correlation_id: correlationId }),
      });
    });
  }
  if (dependencies.audit !== undefined) {
    server.addHook("onRequest", async (request) => {
      bindRequestAudit(request, dependencies.audit as OperationAuditRecorder);
    });
    server.addHook("onResponse", async (request, reply) => {
      await dependencies.audit?.completeHttp(request.id, reply.statusCode);
    });
  }
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
  registerCommandRoute(server, dependencies.application, dependencies.authenticator, {
    ...(dependencies.identity === undefined ? {} : { identity: dependencies.identity }),
    ...(dependencies.audit === undefined ? {} : { audit: dependencies.audit }),
  });
  if (dependencies.feishu_webhook !== undefined) {
    registerFeishuWebhookRoute(server, dependencies.feishu_webhook, config);
  }
  if (dependencies.health !== undefined) {
    registerHealthRoutes(server, {
      health: dependencies.health,
      authenticator: dependencies.authenticator,
      ...(dependencies.identity === undefined ? {} : { identity: dependencies.identity }),
      ...(dependencies.authority === undefined ? {} : { authority: dependencies.authority }),
    });
  }
  if (dependencies.identity !== undefined && dependencies.authority !== undefined) {
    if (dependencies.recovery !== undefined) {
      registerRecoveryRoutes(server, {
        recovery: dependencies.recovery,
        identity: dependencies.identity,
        authority: dependencies.authority,
        authenticator: dependencies.authenticator,
      });
    }
    if (dependencies.operations !== undefined) {
      registerOperationsRoutes(server, {
        operations: dependencies.operations,
        identity: dependencies.identity,
        authority: dependencies.authority,
        authenticator: dependencies.authenticator,
      }, config);
    }
    if (dependencies.collaboration !== undefined) {
      registerCollaborationRoutes(server, {
        collaboration: dependencies.collaboration,
        identity: dependencies.identity,
        authority: dependencies.authority,
        authenticator: dependencies.authenticator,
      }, config);
    }
    if (
      dependencies.schemas !== undefined &&
      dependencies.endpoint_directory !== undefined &&
      dependencies.endpoint_inbox !== undefined
    ) {
      registerEndpointRoutes(server, {
        directory: dependencies.endpoint_directory,
        inbox: dependencies.endpoint_inbox,
        schemas: dependencies.schemas,
        identity: dependencies.identity,
        authority: dependencies.authority,
        authenticator: dependencies.authenticator,
      });
    }
    if (
      dependencies.schemas !== undefined &&
      dependencies.citizen_directory !== undefined
    ) {
      registerCitizenRoutes(server, {
        directory: dependencies.citizen_directory,
        schemas: dependencies.schemas,
        identity: dependencies.identity,
        authority: dependencies.authority,
        authenticator: dependencies.authenticator,
      });
    }
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
      if (dependencies.subscriptions !== undefined && dependencies.schemas !== undefined) {
        registerSubscriptionResourceRoutes(server, {
          query: dependencies.query, subscriptions: dependencies.subscriptions,
          schemas: dependencies.schemas, identity: dependencies.identity,
          authority: dependencies.authority, authenticator: dependencies.authenticator,
        });
      }
    }
    if (dependencies.query !== undefined || dependencies.operations !== undefined) {
      registerAdminRoutes(server, {
        ...(dependencies.query === undefined ? {} : { query: dependencies.query }),
        ...(dependencies.operations === undefined ? {} : { operations: dependencies.operations }),
        identity: dependencies.identity,
        authority: dependencies.authority,
        authenticator: dependencies.authenticator,
      }, config);
    }
  }
  return server;
}
