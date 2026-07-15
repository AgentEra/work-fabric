import type { FastifyInstance } from "fastify";

import type { AuthorityPolicy, IdentityProvider } from "@work-fabric/exchange-spi";

import type { HealthService } from "../health-service.js";
import type { HttpRequestAuthenticator } from "../public-types.js";
import { authorizeRoute } from "./route-authorization.js";

interface Dependencies {
  readonly health: HealthService;
  readonly authenticator?: HttpRequestAuthenticator;
  readonly identity?: IdentityProvider;
  readonly authority?: AuthorityPolicy;
}

export function registerHealthRoutes(
  server: FastifyInstance,
  dependencies: Dependencies,
): void {
  server.get("/health/live", async (_request, reply) =>
    reply.code(200).send({ status: "live" }),
  );

  server.get("/health/ready", async (_request, reply) => {
    const report = await dependencies.health.report();
    return reply
      .code(report.status === "ready" ? 200 : 503)
      .send({ status: report.status });
  });

  server.get("/v1/admin/health", async (request, reply) => {
    if (
      dependencies.authenticator === undefined ||
      dependencies.identity === undefined ||
      dependencies.authority === undefined
    ) {
      return reply.code(404).send({
        statusCode: 404,
        error: "Not Found",
        message: "Route not configured",
      });
    }
    const identity = await authorizeRoute(
      request,
      {
        authenticator: dependencies.authenticator,
        identity: dependencies.identity,
        authority: dependencies.authority,
      },
      "workfabric.operations.health.read.v1",
      null,
    );
    if (identity.kind === "denied") {
      return reply
        .type("application/problem+json")
        .code(identity.problem.status)
        .send(identity.problem);
    }
    const report = await dependencies.health.report();
    return reply.code(report.status === "ready" ? 200 : 503).send(report);
  });
}
