import type { FastifyInstance, FastifyReply } from "fastify";
import type { AuthorityPolicy, IdentityProvider } from "@work-fabric/exchange-spi";
import type {
  CollaborationQueryService,
  RelationshipQueryInput,
  ResponsibilityQueryInput,
  TimelineQueryInput,
} from "@work-fabric/operations-runtime";
import type { ResponsibilityLifecycleState } from "@work-fabric/operations-spi";
import type { HttpServiceConfig } from "../config.js";
import { createProblemDetails } from "../problem-details.js";
import type { HttpRequestAuthenticator } from "../public-types.js";
import { authorizeRoute } from "./route-authorization.js";

type QueryValue = string | readonly string[] | undefined;
interface CommonQuery {
  readonly partition_id?: QueryValue;
  readonly handoff_id?: QueryValue;
  readonly thread_id?: QueryValue;
  readonly cursor?: QueryValue;
  readonly limit?: QueryValue;
}
interface ResponsibilityHttpQuery extends CommonQuery {
  readonly responsible_actor_id?: QueryValue;
  readonly lifecycle_state?: QueryValue;
  readonly priority?: QueryValue;
  readonly due_before?: QueryValue;
}

const lifecycles: readonly ResponsibilityLifecycleState[] = [
  "target_resolution_pending", "target_unavailable", "offered", "accepted",
  "result_returned", "verified", "rework_requested", "closed", "declined",
  "expired", "cancelled", "transferred",
];
const priorities = ["low", "normal", "high", "critical"] as const;

interface Dependencies {
  readonly authenticator: HttpRequestAuthenticator;
  readonly identity: IdentityProvider;
  readonly authority: AuthorityPolicy;
  readonly collaboration: CollaborationQueryService;
}

function scalar(value: QueryValue): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optional(value: QueryValue): string | undefined | null {
  if (value === undefined) return undefined;
  const result = scalar(value);
  return result === null || result.length > 128 || result.trim() !== result
    ? null
    : result;
}

function list<T extends string>(
  value: QueryValue,
  allowed: readonly T[],
): readonly T[] | undefined | null {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : [value];
  if (
    values.length === 0 ||
    values.length > 16 ||
    values.some((item) => typeof item !== "string" || !allowed.includes(item as T))
  ) return null;
  return [...new Set(values as readonly T[])];
}

function pageLimit(value: QueryValue, config: HttpServiceConfig): number | null {
  if (value === undefined) return config.default_page_limit;
  const candidate = scalar(value);
  if (candidate === null || !/^\d+$/.test(candidate)) return null;
  const parsed = Number(candidate);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= config.max_page_limit
    ? parsed
    : null;
}

function cursor(value: QueryValue): string | undefined | null {
  if (value === undefined) return undefined;
  const candidate = scalar(value);
  return candidate !== null && candidate.length <= 2048 ? candidate : null;
}

function invalid(reply: FastifyReply, url: string) {
  return reply.code(400).type("application/problem+json").send(
    createProblemDetails(400, "invalid_request", "Invalid request", { instance: url }),
  );
}

async function authorized(
  request: Parameters<typeof authorizeRoute>[0],
  reply: FastifyReply,
  deps: Dependencies,
  action: string,
  partitionId: string,
) {
  const result = await authorizeRoute(request, deps, action, partitionId);
  if (result.kind === "denied") {
    reply.code(result.problem.status).type("application/problem+json").send(result.problem);
    return null;
  }
  return result;
}

function common(
  query: CommonQuery,
  config: HttpServiceConfig,
): { partition: string; handoff?: string; thread?: string; cursor?: string; limit: number } | null {
  const partition = optional(query.partition_id);
  const handoff = optional(query.handoff_id);
  const thread = optional(query.thread_id);
  const nextCursor = cursor(query.cursor);
  const limit = pageLimit(query.limit, config);
  if (partition === undefined || partition === null || handoff === null || thread === null || nextCursor === null || limit === null) return null;
  return {
    partition,
    ...(handoff === undefined ? {} : { handoff }),
    ...(thread === undefined ? {} : { thread }),
    ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
    limit,
  };
}

export function registerCollaborationRoutes(
  server: FastifyInstance,
  deps: Dependencies,
  config: HttpServiceConfig,
): void {
  server.get<{ Querystring: ResponsibilityHttpQuery }>(
    "/v1/responsibilities",
    async (request, reply) => {
      const parsed = common(request.query, config);
      const actor = optional(request.query.responsible_actor_id);
      const states = list(request.query.lifecycle_state, lifecycles);
      const selectedPriorities = list(request.query.priority, priorities);
      const dueBefore = optional(request.query.due_before);
      if (
        parsed === null || actor === null || states === null ||
        selectedPriorities === null || dueBefore === null ||
        (dueBefore !== undefined && !Number.isFinite(Date.parse(dueBefore)))
      ) return invalid(reply, request.url);
      const auth = await authorized(
        request, reply, deps, "workfabric.query.responsibility.list.v1", parsed.partition,
      );
      if (auth === null) return;
      const input: ResponsibilityQueryInput = {
        partition_id: parsed.partition,
        ...(parsed.thread === undefined ? {} : { thread_id: parsed.thread }),
        ...(actor === undefined ? {} : { responsible_actor_id: actor }),
        ...(states === undefined ? {} : { lifecycle_states: states }),
        ...(selectedPriorities === undefined ? {} : { priorities: selectedPriorities }),
        ...(dueBefore === undefined ? {} : { due_before: dueBefore }),
        ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
        limit: parsed.limit,
      };
      return reply.send(
        await deps.collaboration.listResponsibilities(auth.principal.tenant_id, input),
      );
    },
  );
  server.get<{ Querystring: CommonQuery }>("/v1/timeline", async (request, reply) => {
    const parsed = common(request.query, config);
    if (parsed === null) return invalid(reply, request.url);
    const auth = await authorized(
      request, reply, deps, "workfabric.query.timeline.list.v1", parsed.partition,
    );
    if (auth === null) return;
    const input: TimelineQueryInput = {
      partition_id: parsed.partition,
      ...(parsed.handoff === undefined ? {} : { handoff_id: parsed.handoff }),
      ...(parsed.thread === undefined ? {} : { thread_id: parsed.thread }),
      ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
      limit: parsed.limit,
    };
    return reply.send(await deps.collaboration.listTimeline(auth.principal.tenant_id, input));
  });
  server.get<{ Querystring: CommonQuery }>(
    "/v1/relationships",
    async (request, reply) => {
      const parsed = common(request.query, config);
      if (parsed === null) return invalid(reply, request.url);
      const auth = await authorized(
        request, reply, deps, "workfabric.query.relationship.list.v1", parsed.partition,
      );
      if (auth === null) return;
      const input: RelationshipQueryInput = {
        partition_id: parsed.partition,
        ...(parsed.handoff === undefined ? {} : { handoff_id: parsed.handoff }),
        ...(parsed.thread === undefined ? {} : { thread_id: parsed.thread }),
        ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
        limit: parsed.limit,
      };
      return reply.send(
        await deps.collaboration.listRelationships(auth.principal.tenant_id, input),
      );
    },
  );
}
