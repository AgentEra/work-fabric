import { createHash } from "node:crypto";

import type {
  InvocationAuthorityProvider,
  NormalizedInvocationAuthorityRequest,
} from "@work-fabric/agent-capability-runtime";
import type { RuntimeJsonObject } from "@work-fabric/agent-runtime-spi";
import type {
  HandoffReadModel,
  RequestOptions,
} from "@work-fabric/sdk-typescript";

export interface LocalInvocationAuthorityProviderOptions {
  readonly tenant_id: string;
  readonly agent_actor_id: string;
  readonly queries: {
    getHandoff(
      handoffId: string,
      options?: RequestOptions,
    ): Promise<HandoffReadModel>;
  };
  readonly allowed_namespaces: readonly string[];
  readonly now?: () => string;
}

function record(value: unknown): Record<string, unknown> | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) return null;
  return value as Record<string, unknown>;
}

function sameCandidate(
  left: NormalizedInvocationAuthorityRequest["candidate"],
  right: NormalizedInvocationAuthorityRequest["candidate"],
): boolean {
  return (
    left.citizen_id === right.citizen_id &&
    left.endpoint_id === right.endpoint_id &&
    left.capability_id === right.capability_id &&
    left.capability_version === right.capability_version &&
    left.contract_digest === right.contract_digest
  );
}

function deny(): never {
  throw new Error("Capability authority denied");
}

function requiredScope(capabilityId: string): string {
  if (capabilityId === "feishu.document.read") return "document:read";
  if (capabilityId === "feishu.document.delete") return "document:delete";
  if (
    capabilityId === "feishu.document.create" ||
    capabilityId === "feishu.document.update" ||
    capabilityId === "feishu.document.append"
  ) return "document:write";
  if (capabilityId === "feishu.message.send") return "message:send";
  deny();
}

function stringArray(value: unknown): readonly string[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 32 ||
    value.some((item) =>
      typeof item !== "string" ||
      item.length === 0 ||
      item.length > 128
    )
  ) return null;
  return value as string[];
}

export class LocalInvocationAuthorityProvider
  implements InvocationAuthorityProvider {
  private readonly now: () => string;

  constructor(
    private readonly options: LocalInvocationAuthorityProviderOptions,
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    if (
      options.tenant_id.length === 0 ||
      options.agent_actor_id.length === 0 ||
      options.allowed_namespaces.length === 0
    ) {
      throw new TypeError("Local capability Authority configuration is invalid");
    }
  }

  async authorize(
    input: NormalizedInvocationAuthorityRequest,
    signal: AbortSignal,
  ): Promise<RuntimeJsonObject> {
    if (signal.aborted) deny();
    const request = input.request;
    const expectedWorkReference =
      `urn:work-fabric:capability-invocation:${encodeURIComponent(
        request.original_handoff_id,
      )}:${encodeURIComponent(request.invocation_id)}`;
    if (
      input.tenant_id !== this.options.tenant_id ||
      request.capability_id !== input.candidate.capability_id ||
      input.work_reference_uri !== expectedWorkReference ||
      !this.options.allowed_namespaces.some((namespace) =>
        request.capability_id.startsWith(namespace)
      ) ||
      !sameCandidate(input.candidate, input.contract.candidate) ||
      !Number.isFinite(Date.parse(request.deadline)) ||
      Date.parse(request.deadline) <= Date.parse(this.now())
    ) deny();

    const snapshot = await this.options.queries.getHandoff(
      request.original_handoff_id,
      { signal },
    );
    const state = record(snapshot.state);
    const initiator = record(state?.initiator);
    const responsible = record(state?.current_responsible_actor);
    const handoffPackage = record(state?.package);
    const parentAuthority = record(handoffPackage?.authority_scope);
    const originalDeadline = handoffPackage?.result_due_at;
    const parentDelegationId = parentAuthority?.delegation_id;
    const parentScopes = stringArray(parentAuthority?.scopes);
    const parentExpiresAt = parentAuthority?.expires_at;
    const operationScope = requiredScope(request.capability_id);
    if (
      snapshot.tenant_id !== this.options.tenant_id ||
      snapshot.handoff_id !== request.original_handoff_id ||
      state?.lifecycle_state !== "accepted" ||
      initiator?.actor_type !== "human" ||
      typeof initiator.actor_id !== "string" ||
      initiator.actor_id.length === 0 ||
      responsible?.actor_type !== "agent" ||
      responsible.actor_id !== this.options.agent_actor_id ||
      typeof originalDeadline !== "string" ||
      !Number.isFinite(Date.parse(originalDeadline)) ||
      Date.parse(request.deadline) > Date.parse(originalDeadline) ||
      typeof parentDelegationId !== "string" ||
      parentDelegationId.length === 0 ||
      parentDelegationId.length > 128 ||
      parentScopes === null ||
      !parentScopes.includes(operationScope) ||
      typeof parentExpiresAt !== "string" ||
      !Number.isFinite(Date.parse(parentExpiresAt)) ||
      Date.parse(request.deadline) > Date.parse(parentExpiresAt) ||
      parentAuthority?.may_redelegate !== true
    ) deny();

    const delegationId =
      `capability-delegation-${createHash("sha256")
        .update([
          this.options.tenant_id,
          request.original_handoff_id,
          request.invocation_id,
          input.candidate.citizen_id,
          input.candidate.contract_digest,
        ].join("\u0000"))
        .digest("hex")
        .slice(0, 32)}`;
    return Object.freeze({
      delegation_id: delegationId,
      scopes: Object.freeze(["capability:invoke", operationScope]),
      resource_refs: Object.freeze([input.work_reference_uri]),
      expires_at: request.deadline,
      may_redelegate: false,
      extensions: Object.freeze({
        "workfabric.dev/capability_authority": Object.freeze({
          original_handoff_id: request.original_handoff_id,
          invocation_id: request.invocation_id,
          represented_actor_id: initiator.actor_id,
          delegation_id: delegationId,
          parent_delegation_id: parentDelegationId,
          delegation_scopes: Object.freeze([operationScope]),
          delegation_expires_at: request.deadline,
          capability_version: input.candidate.capability_version,
          contract_digest: input.candidate.contract_digest,
          allowed_target_refs: Object.freeze([]),
          confirmation_proof_refs: Object.freeze([]),
        }),
      }),
    }) as RuntimeJsonObject;
  }
}
