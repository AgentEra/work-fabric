import type { FastifyInstance, FastifyReply } from "fastify";
import type { AuthorityPolicy, IdentityProvider, JsonObject } from "@work-fabric/exchange-spi";
import { assertSafeOperationsJson, type RecoveryTarget } from "@work-fabric/operations-spi";
import type { RecoveryService } from "@work-fabric/operations-runtime";

import { createProblemDetails } from "../problem-details.js";
import type { HttpRequestAuthenticator } from "../public-types.js";
import { authorizeRoute, requestTraceId } from "./route-authorization.js";

interface Dependencies {
  readonly recovery: RecoveryService;
  readonly authenticator: HttpRequestAuthenticator;
  readonly identity: IdentityProvider;
  readonly authority: AuthorityPolicy;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} is invalid`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !fields.includes(key))) {
    throw new TypeError(`${label} contains unsupported fields`);
  }
}

function text(value: unknown, field: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > 255 ||
    value.trim() !== value
  ) throw new TypeError(`${field} is invalid`);
  return value;
}

function time(value: unknown, field: string): string {
  const result = text(value, field);
  if (!Number.isFinite(Date.parse(result))) throw new TypeError(`${field} is invalid`);
  return result;
}

function reason(value: unknown): string {
  const result = text(value, "reason");
  if (
    result.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(result) ||
    /(?:bearer|token|secret|password|credential)/i.test(result)
  ) throw new TypeError("reason is invalid");
  return result;
}

function target(value: unknown): RecoveryTarget {
  const candidate = object(value, "target");
  switch (candidate.kind) {
    case "connector_requeue":
      exact(candidate, ["kind", "connector_id", "ingress_id", "available_at"], "target");
      return {
        kind: candidate.kind,
        connector_id: text(candidate.connector_id, "connector_id"),
        ingress_id: text(candidate.ingress_id, "ingress_id"),
        available_at: time(candidate.available_at, "available_at"),
      };
    case "delivery_replay":
      exact(candidate, ["kind", "subscription_id", "partition_id", "event_id"], "target");
      return {
        kind: candidate.kind,
        subscription_id: text(candidate.subscription_id, "subscription_id"),
        partition_id: text(candidate.partition_id, "partition_id"),
        event_id: text(candidate.event_id, "event_id"),
      };
    case "projection_rebuild":
      exact(candidate, ["kind", "projector_id", "partition_id"], "target");
      return {
        kind: candidate.kind,
        projector_id: text(candidate.projector_id, "projector_id"),
        partition_id: text(candidate.partition_id, "partition_id"),
      };
    case "discrepancy_acknowledge":
      exact(candidate, ["kind", "discrepancy_id"], "target");
      return {
        kind: candidate.kind,
        discrepancy_id: text(candidate.discrepancy_id, "discrepancy_id"),
      };
    default:
      throw new TypeError("target kind is invalid");
  }
}

function resource(value: RecoveryTarget): string {
  switch (value.kind) {
    case "connector_requeue": return value.connector_id;
    case "delivery_replay": return value.subscription_id;
    case "projection_rebuild": return value.partition_id;
    case "discrepancy_acknowledge": return value.discrepancy_id;
  }
}

function action(value: RecoveryTarget): string {
  return `workfabric.operations.recovery.${value.kind.replaceAll("_", "-")}.request.v1`;
}

function invalid(reply: FastifyReply, url: string) {
  return reply.code(400).type("application/problem+json").send(
    createProblemDetails(400, "invalid_request", "Invalid request", { instance: url }),
  );
}

export function registerRecoveryRoutes(
  server: FastifyInstance,
  dependencies: Dependencies,
): void {
  server.post("/v1/operations/recoveries", async (request, reply) => {
    let input: {
      readonly idempotency_key: string;
      readonly target: RecoveryTarget;
      readonly expected_version: number;
      readonly reason: string;
    };
    try {
      const body = object(request.body, "body");
      assertSafeOperationsJson(body as JsonObject, "recovery request");
      exact(body, ["idempotency_key", "target", "expected_version", "reason"], "body");
      if (!Number.isSafeInteger(body.expected_version) || (body.expected_version as number) < 0) {
        throw new TypeError("expected_version is invalid");
      }
      input = {
        idempotency_key: text(body.idempotency_key, "idempotency_key"),
        target: target(body.target),
        expected_version: body.expected_version as number,
        reason: reason(body.reason),
      };
    } catch {
      return invalid(reply, request.url);
    }
    const auth = await authorizeRoute(
      request,
      dependencies,
      action(input.target),
      resource(input.target),
    );
    if (auth.kind === "denied") {
      return reply.code(auth.problem.status).type("application/problem+json").send(auth.problem);
    }
    const result = await dependencies.recovery.request(
      auth.principal.tenant_id,
      auth.principal.principal_id,
      {
        request_id: request.id,
        trace_id: requestTraceId(request),
        ...input,
      },
    );
    return reply.code(result.kind === "accepted" ? 202 : result.kind === "replayed" ? 200 : 409).send(result);
  });

  server.get<{ Params: { recoveryId: string } }>(
    "/v1/operations/recoveries/:recoveryId",
    async (request, reply) => {
      let recoveryId: string;
      try { recoveryId = text(request.params.recoveryId, "recoveryId"); } catch { return invalid(reply, request.url); }
      const auth = await authorizeRoute(
        request, dependencies, "workfabric.operations.recovery.read.v1", recoveryId,
      );
      if (auth.kind === "denied") {
        return reply.code(auth.problem.status).type("application/problem+json").send(auth.problem);
      }
      const record = await dependencies.recovery.get(auth.principal.tenant_id, recoveryId);
      if (record === null) {
        return reply.code(404).type("application/problem+json").send(
          createProblemDetails(404, "not_found", "Recovery request not found", { instance: request.url }),
        );
      }
      return reply.send(record);
    },
  );
}
