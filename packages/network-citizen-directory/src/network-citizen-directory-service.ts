import { isDeepStrictEqual } from "node:util";

import {
  canonicalCitizenDigest,
  validateCitizenDeclarations,
  validateCitizenProvisioning,
  validateNetworkCitizenDescriptor,
  type CitizenActorReference,
  type CitizenCardPage,
  type CitizenDeclaration,
  type CitizenDeclarationContract,
  type CitizenDeclarationReplaceInput,
  type CitizenDeclarationSummary,
  type CitizenDeclarationSummaryPage,
  type CitizenDiscoveryQuery,
  type CitizenHeartbeatInput,
  type CitizenProvisioning,
  type CitizenRisk,
  type CitizenSchemaDigestBinding,
  type CitizenSessionCloseInput,
  type CitizenSessionOpenInput,
  type NetworkCitizenDescriptor,
  type NetworkCitizenStore,
  type PublicCitizenSession,
  type StoredCitizenProvisioning,
  type StoredCitizenSession,
} from "@work-fabric/network-citizen-spi";

import {
  CitizenDirectoryError,
  mapCitizenStoreError,
} from "./errors.js";

export interface CitizenCallContext {
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly represented_actor?: CitizenActorReference;
  readonly represented_endpoint_id?: string;
}

export interface CitizenDirectoryClock {
  now(): string;
}

export interface CitizenDirectoryLimits {
  readonly min_lease_seconds: number;
  readonly default_lease_seconds: number;
  readonly max_lease_seconds: number;
  readonly renew_ahead_seconds: number;
  readonly max_declarations: number;
  readonly default_page_limit: number;
  readonly max_page_limit: number;
}

export interface CitizenDiscoveryInput {
  readonly citizen_kind?: CitizenDiscoveryQuery["citizen_kind"];
  readonly declaration_id?: string;
  readonly availability?: CitizenDiscoveryQuery["availability"];
  readonly executable_only?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
}

const RISK_ORDER: Readonly<Record<CitizenRisk, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  destructive: 3,
};

function addSeconds(timestamp: string, seconds: number): string {
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) {
    throw new CitizenDirectoryError("invalid_request", "Clock returned an invalid timestamp");
  }
  return new Date(value + seconds * 1000).toISOString();
}

function publicProvisioning(
  value: StoredCitizenProvisioning,
): CitizenProvisioning {
  const {
    tenant_id: _tenant,
    created_at: _created,
    updated_at: _updated,
    ...result
  } = value;
  return result;
}

function publicSession(value: StoredCitizenSession): PublicCitizenSession {
  const {
    tenant_id: _tenant,
    request_digest: _digest,
    opened_at: _opened,
    updated_at: _updated,
    ...result
  } = value;
  return result;
}

function declarationSummary(
  value: CitizenDeclaration,
): CitizenDeclarationSummary {
  return {
    declaration_id: value.declaration_id,
    declaration_kind: value.declaration_kind,
    version: value.version,
    name: value.name,
    description: value.description,
  };
}

function schemaBindings(
  declarations: readonly CitizenDeclaration[],
): readonly CitizenSchemaDigestBinding[] {
  const bindings = new Map<string, `sha256:${string}`>();
  for (const declaration of declarations) {
    for (const reference of [
      declaration.input_schema,
      declaration.output_schema,
    ]) {
      if (reference === undefined) continue;
      const existing = bindings.get(reference.uri);
      if (existing !== undefined && existing !== reference.digest) {
        throw new CitizenDirectoryError(
          "schema_digest_conflict",
          "One declaration set binds a Schema URI to different digests",
        );
      }
      bindings.set(reference.uri, reference.digest);
    }
  }
  return [...bindings].map(([uri, digest]) => ({ uri, digest }));
}

function validateLimits(limits: CitizenDirectoryLimits): void {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError("Citizen Directory limits must be positive integers");
    }
  }
  if (
    limits.min_lease_seconds > limits.default_lease_seconds ||
    limits.default_lease_seconds > limits.max_lease_seconds
  ) {
    throw new TypeError("Citizen Directory lease limits must satisfy min <= default <= max");
  }
  if (limits.renew_ahead_seconds >= limits.min_lease_seconds) {
    throw new TypeError("renew_ahead_seconds must be less than min_lease_seconds");
  }
  if (limits.default_page_limit > limits.max_page_limit) {
    throw new TypeError("default_page_limit must not exceed max_page_limit");
  }
}

export class NetworkCitizenDirectoryService {
  constructor(private readonly dependencies: {
    readonly store: NetworkCitizenStore;
    readonly clock: CitizenDirectoryClock;
    readonly ids: { sessionId(): string };
    readonly limits: CitizenDirectoryLimits;
  }) {
    validateLimits(dependencies.limits);
  }

  async provision(
    context: CitizenCallContext,
    input: CitizenProvisioning,
    expectedVersion: number | null,
  ): Promise<CitizenProvisioning> {
    this.assertContext(context);
    const validated = validateCitizenProvisioning(input);
    if (
      (expectedVersion === null && validated.registration_version !== 1) ||
      (expectedVersion !== null &&
        validated.registration_version !== expectedVersion + 1)
    ) {
      throw new CitizenDirectoryError(
        "version_conflict",
        "Citizen registration version is invalid",
      );
    }
    try {
      return publicProvisioning(
        await this.dependencies.store.putProvisioning({
          tenant_id: context.tenant_id,
          provisioning: validated,
          expected_registration_version: expectedVersion,
          recorded_at: this.dependencies.clock.now(),
        }),
      );
    } catch (error) {
      throw mapCitizenStoreError(error);
    }
  }

  async openSession(
    context: CitizenCallContext,
    citizenId: string,
    input: CitizenSessionOpenInput,
  ): Promise<PublicCitizenSession> {
    const provisioning = await this.provisioningForRuntime(context, citizenId);
    if (provisioning.registration_version !== input.expected_registration_version) {
      throw new CitizenDirectoryError("version_conflict", "Citizen registration version is stale");
    }
    const descriptor = validateNetworkCitizenDescriptor(input.descriptor);
    const declarations = this.validateDeclarations(
      provisioning,
      descriptor,
      input.declarations,
    );
    if (
      typeof input.client_session_id !== "string" ||
      input.client_session_id.length === 0 ||
      input.client_session_id.length > 128
    ) {
      throw new CitizenDirectoryError("invalid_request", "client_session_id is invalid");
    }
    const lease = input.requested_lease_seconds ?? this.dependencies.limits.default_lease_seconds;
    if (
      !Number.isSafeInteger(lease) ||
      lease < this.dependencies.limits.min_lease_seconds ||
      lease > this.dependencies.limits.max_lease_seconds
    ) {
      throw new CitizenDirectoryError("invalid_request", "requested lease is outside configured bounds");
    }
    const requestDigest = canonicalCitizenDigest({
      ...input,
      descriptor,
      declarations,
    });
    const replay = await this.dependencies.store.getSessionByClientId(
      context.tenant_id,
      citizenId,
      input.client_session_id,
    );
    if (replay !== null) {
      if (replay.request_digest !== requestDigest) {
        throw new CitizenDirectoryError("idempotency_conflict", "client_session_id was reused with different content");
      }
      return publicSession(replay);
    }
    try {
      await this.dependencies.store.bindSchemaDigests(
        context.tenant_id,
        schemaBindings(declarations),
      );
      const openedAt = this.dependencies.clock.now();
      return publicSession(
        await this.dependencies.store.openSession({
          tenant_id: context.tenant_id,
          citizen_id: citizenId,
          session_id: this.dependencies.ids.sessionId(),
          client_session_id: input.client_session_id,
          descriptor,
          declarations,
          accepted_lease_seconds: lease,
          registration_version: provisioning.registration_version,
          request_digest: requestDigest,
          expires_at: addSeconds(openedAt, lease),
          renew_after: addSeconds(
            openedAt,
            lease - this.dependencies.limits.renew_ahead_seconds,
          ),
          opened_at: openedAt,
        }),
      );
    } catch (error) {
      throw mapCitizenStoreError(error);
    }
  }

  async heartbeat(
    context: CitizenCallContext,
    citizenId: string,
    sessionId: string,
    input: CitizenHeartbeatInput,
  ): Promise<PublicCitizenSession> {
    const provisioning = await this.provisioningForRuntime(context, citizenId);
    if (provisioning.registration_version !== input.expected_registration_version) {
      throw new CitizenDirectoryError("version_conflict", "Citizen registration version is stale");
    }
    const current = await this.session(context, citizenId, sessionId);
    const now = this.dependencies.clock.now();
    try {
      return publicSession(
        await this.dependencies.store.heartbeat({
          tenant_id: context.tenant_id,
          citizen_id: citizenId,
          session_id: sessionId,
          fencing_token: input.fencing_token,
          heartbeat_sequence: input.heartbeat_sequence,
          availability: input.availability,
          request_digest: canonicalCitizenDigest(input),
          expires_at: addSeconds(now, current.accepted_lease_seconds),
          renew_after: addSeconds(
            now,
            current.accepted_lease_seconds -
              this.dependencies.limits.renew_ahead_seconds,
          ),
          updated_at: now,
        }),
      );
    } catch (error) {
      throw mapCitizenStoreError(error);
    }
  }

  async replaceDeclarations(
    context: CitizenCallContext,
    citizenId: string,
    sessionId: string,
    input: CitizenDeclarationReplaceInput,
  ): Promise<PublicCitizenSession> {
    const provisioning = await this.provisioningForRuntime(context, citizenId);
    if (provisioning.registration_version !== input.expected_registration_version) {
      throw new CitizenDirectoryError("version_conflict", "Citizen registration version is stale");
    }
    const current = await this.session(context, citizenId, sessionId);
    const declarations = this.validateDeclarations(
      provisioning,
      current.descriptor,
      input.declarations,
      false,
    );
    const declarationDigest = canonicalCitizenDigest(declarations);
    try {
      await this.dependencies.store.bindSchemaDigests(
        context.tenant_id,
        schemaBindings(declarations),
      );
      return publicSession(
        await this.dependencies.store.replaceDeclarations({
          tenant_id: context.tenant_id,
          citizen_id: citizenId,
          session_id: sessionId,
          fencing_token: input.fencing_token,
          registration_version: input.expected_registration_version,
          expected_declaration_version: input.expected_declaration_version,
          declarations,
          declaration_digest: declarationDigest,
          request_digest: canonicalCitizenDigest({
            ...input,
            declarations,
          }),
          updated_at: this.dependencies.clock.now(),
        }),
      );
    } catch (error) {
      throw mapCitizenStoreError(error);
    }
  }

  async closeSession(
    context: CitizenCallContext,
    citizenId: string,
    sessionId: string,
    input: CitizenSessionCloseInput,
  ): Promise<PublicCitizenSession> {
    const provisioning = await this.provisioningForRuntime(context, citizenId);
    if (provisioning.registration_version !== input.expected_registration_version) {
      throw new CitizenDirectoryError("version_conflict", "Citizen registration version is stale");
    }
    try {
      return publicSession(
        await this.dependencies.store.closeSession({
          tenant_id: context.tenant_id,
          citizen_id: citizenId,
          session_id: sessionId,
          fencing_token: input.fencing_token,
          heartbeat_sequence: input.heartbeat_sequence,
          registration_version: input.expected_registration_version,
          request_digest: canonicalCitizenDigest(input),
          closed_at: this.dependencies.clock.now(),
        }),
      );
    } catch (error) {
      throw mapCitizenStoreError(error);
    }
  }

  async discoverCitizens(
    context: CitizenCallContext,
    input: CitizenDiscoveryInput = {},
  ): Promise<CitizenCardPage> {
    this.assertContext(context);
    const limit = input.limit ?? this.dependencies.limits.default_page_limit;
    if (
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      limit > this.dependencies.limits.max_page_limit
    ) {
      throw new CitizenDirectoryError("invalid_request", "discovery limit is outside configured bounds");
    }
    try {
      const page = await this.dependencies.store.discover({
        tenant_id: context.tenant_id,
        ...(input.citizen_kind === undefined ? {} : { citizen_kind: input.citizen_kind }),
        ...(input.declaration_id === undefined ? {} : { declaration_id: input.declaration_id }),
        ...(input.availability === undefined ? {} : { availability: input.availability }),
        ...(input.executable_only === undefined ? {} : { executable_only: input.executable_only }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        limit,
        now: this.dependencies.clock.now(),
      });
      return {
        items: page.items.map((item) => structuredClone(item.descriptor)),
        ...(page.next_cursor === undefined ? {} : { next_cursor: page.next_cursor }),
      };
    } catch (error) {
      if (error instanceof TypeError) {
        throw new CitizenDirectoryError("invalid_request", error.message);
      }
      throw mapCitizenStoreError(error);
    }
  }

  async getCitizen(
    context: CitizenCallContext,
    citizenId: string,
  ): Promise<NetworkCitizenDescriptor> {
    this.assertContext(context);
    const projected = await this.dependencies.store.getProjectedCitizen(
      context.tenant_id,
      citizenId,
      this.dependencies.clock.now(),
    );
    if (projected === null) {
      throw new CitizenDirectoryError("not_found", "Network Citizen was not found");
    }
    return structuredClone(projected.descriptor);
  }

  async listDeclarations(
    context: CitizenCallContext,
    citizenId: string,
  ): Promise<CitizenDeclarationSummaryPage> {
    const projected = await this.projected(context, citizenId);
    return {
      items: projected.declarations.map(declarationSummary),
    };
  }

  async getDeclaration(
    context: CitizenCallContext,
    citizenId: string,
    declarationId: string,
  ): Promise<CitizenDeclarationContract> {
    const projected = await this.projected(context, citizenId);
    const declaration = projected.declarations.find(
      (item) => item.declaration_id === declarationId,
    );
    if (declaration === undefined) {
      throw new CitizenDirectoryError("not_found", "Citizen declaration was not found");
    }
    if (projected.lease === null) {
      throw new CitizenDirectoryError("not_found", "Citizen declaration is unavailable");
    }
    return {
      citizen_id: citizenId,
      citizen_kind: projected.descriptor.citizen_kind,
      availability: projected.descriptor.availability,
      declaration: structuredClone(declaration),
      declaration_version: projected.lease.declaration_version,
      fencing_token: projected.lease.fencing_token,
    };
  }

  private async projected(context: CitizenCallContext, citizenId: string) {
    this.assertContext(context);
    const projected = await this.dependencies.store.getProjectedCitizen(
      context.tenant_id,
      citizenId,
      this.dependencies.clock.now(),
    );
    if (
      projected === null ||
      projected.descriptor.availability === "unavailable"
    ) {
      throw new CitizenDirectoryError("not_found", "Network Citizen was not found");
    }
    return projected;
  }

  private async session(
    context: CitizenCallContext,
    citizenId: string,
    sessionId: string,
  ): Promise<StoredCitizenSession> {
    const current = await this.dependencies.store.getSession(
      context.tenant_id,
      citizenId,
      sessionId,
    );
    if (current === null) {
      throw new CitizenDirectoryError("not_found", "Citizen session was not found");
    }
    return current;
  }

  private validateDeclarations(
    provisioning: StoredCitizenProvisioning,
    descriptor: NetworkCitizenDescriptor,
    input: readonly CitizenDeclaration[],
    checkDescriptorDigest = true,
  ): readonly CitizenDeclaration[] {
    if (
      descriptor.citizen_id !== provisioning.citizen_id ||
      descriptor.citizen_kind !== provisioning.citizen_kind ||
      descriptor.identity?.principal_id !== provisioning.principal_id ||
      !isDeepStrictEqual(descriptor.identity?.actor, provisioning.allowed_actor) ||
      descriptor.identity?.endpoint_id !== provisioning.allowed_endpoint_id
    ) {
      throw new CitizenDirectoryError("representation_denied", "Citizen descriptor identity is not provisioned");
    }
    const declarations = validateCitizenDeclarations(input);
    if (declarations.length > this.dependencies.limits.max_declarations) {
      throw new CitizenDirectoryError("invalid_request", "declarations exceed configured bound");
    }
    const digest = canonicalCitizenDigest(declarations);
    if (
      checkDescriptorDigest &&
      (descriptor.declarations.count !== declarations.length ||
        descriptor.declarations.digest !== digest)
    ) {
      throw new CitizenDirectoryError("invalid_request", "descriptor declaration digest does not match declarations");
    }
    for (const declaration of declarations) {
      const namespace = declaration.declaration_id.split(".", 1)[0]!;
      if (!provisioning.allowed_declaration_namespaces.includes(namespace)) {
        throw new CitizenDirectoryError("invalid_request", "declaration namespace is not provisioned");
      }
      if (RISK_ORDER[declaration.risk] > RISK_ORDER[provisioning.maximum_risk]) {
        throw new CitizenDirectoryError("invalid_request", "declaration risk exceeds provisioned ceiling");
      }
      if (
        (provisioning.citizen_kind === "capability-provider" &&
          declaration.declaration_kind !== "capability") ||
        (provisioning.citizen_kind === "channel" &&
          declaration.declaration_kind !== "channel") ||
        (provisioning.citizen_kind === "context-provider" &&
          declaration.declaration_kind !== "context") ||
        (provisioning.citizen_kind === "governance-provider" &&
          declaration.declaration_kind !== "policy") ||
        (provisioning.citizen_kind === "observer")
      ) {
        throw new CitizenDirectoryError("invalid_request", "declaration kind is incompatible with Citizen kind");
      }
    }
    return declarations;
  }

  private async provisioningForRuntime(
    context: CitizenCallContext,
    citizenId: string,
  ): Promise<StoredCitizenProvisioning> {
    this.assertContext(context);
    const provisioning = await this.dependencies.store.getProvisioning(
      context.tenant_id,
      citizenId,
    );
    if (
      provisioning === null ||
      provisioning.administrative_state !== "enabled"
    ) {
      throw new CitizenDirectoryError("not_found", "Network Citizen was not found");
    }
    if (
      context.principal_id !== provisioning.principal_id ||
      !isDeepStrictEqual(context.represented_actor, provisioning.allowed_actor) ||
      context.represented_endpoint_id !== provisioning.allowed_endpoint_id
    ) {
      throw new CitizenDirectoryError("representation_denied", "Runtime cannot represent this Citizen");
    }
    return provisioning;
  }

  private assertContext(context: CitizenCallContext): void {
    if (
      typeof context.tenant_id !== "string" ||
      context.tenant_id.length === 0 ||
      typeof context.principal_id !== "string" ||
      context.principal_id.length === 0
    ) {
      throw new CitizenDirectoryError("invalid_request", "Citizen call context is invalid");
    }
  }
}
