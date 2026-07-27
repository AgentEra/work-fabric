import type {
  EndpointClaimableHandoffPage,
  EndpointDirectoryStore,
  EndpointInboxPartitionPage,
  EndpointInboxStore,
  ResolvedPrincipal,
} from "@work-fabric/exchange-spi";
import type { Clock } from "@work-fabric/exchange-core";

export type EndpointInboxQueryErrorCode =
  | "not_found"
  | "invalid_request"
  | "unavailable";

export class EndpointInboxQueryError extends Error {
  constructor(
    readonly code: EndpointInboxQueryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EndpointInboxQueryError";
  }
}

export interface EndpointInboxQueryContext {
  readonly tenant_id: string;
  readonly principal: ResolvedPrincipal;
}

export interface EndpointInboxPartitionInput {
  readonly cursor?: string;
  readonly limit?: number;
}

export type EndpointClaimableHandoffInput = EndpointInboxPartitionInput;

export class EndpointInboxQueryService {
  constructor(private readonly dependencies: {
    readonly directory: EndpointDirectoryStore;
    readonly inbox: EndpointInboxStore;
    readonly clock: Clock;
    readonly defaultPageLimit: number;
    readonly maxPageLimit: number;
  }) {
    for (const [field, value] of [
      ["defaultPageLimit", dependencies.defaultPageLimit],
      ["maxPageLimit", dependencies.maxPageLimit],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${field} must be a positive safe integer`);
      }
    }
    if (dependencies.defaultPageLimit > dependencies.maxPageLimit) {
      throw new TypeError("defaultPageLimit must not exceed maxPageLimit");
    }
  }

  async listPartitions(
    context: EndpointInboxQueryContext,
    endpointId: string,
    input: EndpointInboxPartitionInput,
  ): Promise<EndpointInboxPartitionPage> {
    const limit = input.limit ?? this.dependencies.defaultPageLimit;
    if (
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      limit > this.dependencies.maxPageLimit
    ) {
      throw new EndpointInboxQueryError(
        "invalid_request",
        "inbox page limit is outside configured bounds",
      );
    }
    const registration = await this.representedRegistration(
      context,
      endpointId,
    );
    try {
      return await this.dependencies.inbox.listPartitions({
        tenant_id: context.tenant_id,
        actor_id: registration.actor.actor_id,
        endpoint_id: endpointId,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        limit,
      });
    } catch (error) {
      if (error instanceof TypeError) {
        throw new EndpointInboxQueryError("invalid_request", "inbox cursor is invalid");
      }
      throw new EndpointInboxQueryError(
        "unavailable",
        "Endpoint inbox is unavailable",
      );
    }
  }

  async listClaimableHandoffs(
    context: EndpointInboxQueryContext,
    endpointId: string,
    input: EndpointClaimableHandoffInput,
  ): Promise<EndpointClaimableHandoffPage> {
    const limit = this.pageLimit(input.limit);
    await this.representedRegistration(context, endpointId);
    let endpoint;
    try {
      endpoint = await this.dependencies.directory.getProjectedEndpoint(
        context.tenant_id,
        endpointId,
        this.dependencies.clock.now(),
      );
    } catch {
      throw new EndpointInboxQueryError(
        "unavailable",
        "Endpoint candidate pool is unavailable",
      );
    }
    if (endpoint === null || endpoint.capabilities.length === 0) {
      return { items: [] };
    }
    try {
      return await this.dependencies.inbox.listClaimableHandoffs({
        tenant_id: context.tenant_id,
        endpoint_id: endpointId,
        capability_ids: endpoint.capabilities.map(
          ({ capability_id }) => capability_id,
        ),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        limit,
      });
    } catch (error) {
      if (error instanceof TypeError) {
        throw new EndpointInboxQueryError(
          "invalid_request",
          "candidate pool cursor is invalid",
        );
      }
      throw new EndpointInboxQueryError(
        "unavailable",
        "Endpoint candidate pool is unavailable",
      );
    }
  }

  private pageLimit(value: number | undefined): number {
    const limit = value ?? this.dependencies.defaultPageLimit;
    if (
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      limit > this.dependencies.maxPageLimit
    ) {
      throw new EndpointInboxQueryError(
        "invalid_request",
        "inbox page limit is outside configured bounds",
      );
    }
    return limit;
  }

  private async representedRegistration(
    context: EndpointInboxQueryContext,
    endpointId: string,
  ) {
    if (context.principal.tenant_id !== context.tenant_id) {
      throw new EndpointInboxQueryError("not_found", "Endpoint was not found");
    }
    let registration;
    try {
      registration = await this.dependencies.directory.getRegistration(
        context.tenant_id,
        endpointId,
      );
    } catch {
      throw new EndpointInboxQueryError(
        "unavailable",
        "Endpoint inbox is unavailable",
      );
    }
    if (
      registration === null ||
      registration.administrative_state !== "enabled"
    ) {
      throw new EndpointInboxQueryError("not_found", "Endpoint was not found");
    }
    const represents = context.principal.actor_claims.some((claim) =>
      claim.actor_id === registration.actor.actor_id &&
      claim.actor_type === registration.actor.actor_type &&
      claim.endpoint_ids.includes(endpointId),
    );
    if (!represents) {
      throw new EndpointInboxQueryError("not_found", "Endpoint was not found");
    }
    return registration;
  }
}
