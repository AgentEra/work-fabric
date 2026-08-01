import { createHash } from "node:crypto";

import {
  validateCapabilityInvocationRequest,
  validateCapabilityInvocationResult,
  type AgentCapabilityInvocationStore,
  type CapabilityCandidate,
  type CapabilityInvocationPort,
  type CapabilityInvocationRecord,
  type CapabilityInvocationRequest,
  type CapabilityInvocationResult,
  type RuntimeJsonObject,
} from "@work-fabric/agent-runtime-spi";
import type {
  ExistingHandoffCommandOptions,
  HandoffOfferPayload,
  NewCommandOptions,
  OperationResult,
} from "@work-fabric/sdk-typescript";

import type {
  AuxiliaryHandoffTerminal,
  AuxiliaryHandoffWaiter,
  BoundCapabilityContract,
  CapabilityContractResolver,
  CapabilityHandoffClient,
  InvocationAuthorityProvider,
  InvocationSchemaValidator,
} from "./contracts.js";

const TERMINAL = new Set(["succeeded", "rejected", "failed", "cancelled"]);

export interface HandoffCapabilityInvocationDependencies {
  readonly tenant_id: string;
  readonly owner_id: string;
  readonly verifier: {
    readonly actor_id: string;
    readonly actor_type: "human" | "agent" | "system";
  };
  readonly resolver: CapabilityContractResolver;
  readonly schemas: InvocationSchemaValidator;
  readonly authority: InvocationAuthorityProvider;
  readonly handoffs: CapabilityHandoffClient;
  readonly waiter: AuxiliaryHandoffWaiter;
  readonly state: AgentCapabilityInvocationStore;
  readonly now?: () => string;
  readonly lease_seconds?: number;
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")}`;
}

function commandKey(
  request: CapabilityInvocationRequest,
  action: "offer" | "resolve",
): string {
  return `agent-capability-${action}-${createHash("sha256")
    .update(`${request.original_handoff_id}\u0000${request.invocation_id}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function bindingEvidenceId(request: CapabilityInvocationRequest): string {
  return `capability-binding-${createHash("sha256")
    .update(`${request.original_handoff_id}\u0000${request.invocation_id}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function workReference(request: CapabilityInvocationRequest): string {
  return `urn:work-fabric:capability-invocation:${encodeURIComponent(
    request.original_handoff_id,
  )}:${encodeURIComponent(request.invocation_id)}`;
}

function resourceField(
  operation: OperationResult,
  field: "resource_id" | "resource_version",
): unknown {
  return operation.resource?.[field];
}

function acceptedResource(operation: OperationResult): {
  readonly resource_id: string;
  readonly resource_version: number;
} {
  const resourceId = resourceField(operation, "resource_id");
  const resourceVersion = resourceField(operation, "resource_version");
  if (
    operation.operation_status !== "accepted" ||
    typeof resourceId !== "string" ||
    resourceId.length === 0 ||
    !Number.isSafeInteger(resourceVersion) ||
    (resourceVersion as number) < 1
  ) {
    throw new Error(`Handoff command ${operation.operation_status}`);
  }
  return {
    resource_id: resourceId,
    resource_version: resourceVersion as number,
  };
}

function terminalResult(
  record: CapabilityInvocationRecord,
): CapabilityInvocationResult | null {
  if (!TERMINAL.has(record.state)) return null;
  return record.result;
}

function failure(
  request: CapabilityInvocationRequest,
  auxiliaryHandoffId: string | null,
  code: string,
  message: string,
  retryable: boolean,
  outcome: "rejected" | "failed" = "failed",
): CapabilityInvocationResult {
  return validateCapabilityInvocationResult({
    outcome,
    invocation_id: request.invocation_id,
    auxiliary_handoff_id: auxiliaryHandoffId,
    code,
    message,
    retryable,
  });
}

function terminalFailure(
  request: CapabilityInvocationRequest,
  auxiliaryHandoffId: string,
  terminal: Exclude<AuxiliaryHandoffTerminal, { readonly outcome: "succeeded" }>,
): CapabilityInvocationResult {
  return failure(
    request,
    auxiliaryHandoffId,
    terminal.code,
    terminal.message,
    terminal.retryable,
    terminal.outcome,
  );
}

function offerPayload(
  request: CapabilityInvocationRequest,
  candidate: CapabilityCandidate,
  contract: BoundCapabilityContract,
  authorityScope: RuntimeJsonObject,
  verifier: HandoffCapabilityInvocationDependencies["verifier"],
): HandoffOfferPayload {
  const uri = workReference(request);
  return {
    thread_id: request.thread_id,
    work_reference: {
      uri,
      extensions: {
        "workfabric.dev/original_handoff_id": request.original_handoff_id,
        "workfabric.dev/invocation_id": request.invocation_id,
      },
    },
    target: {
      capability_requirement: {
        capability_id: request.capability_id,
        version_constraint: request.version_constraint,
        assignment_mode: "external_resolution",
        constraints: {
          selected_citizen_id: candidate.citizen_id,
          contract_digest: candidate.contract_digest,
        },
      },
    },
    intent: [{
      kind: "data",
      schema_ref:
        contract.input_schema?.uri ??
        "urn:work-fabric:schema:agent-capability-input:1",
      data: request.input,
    }],
    authority_scope: authorityScope,
    acceptance_criteria: [{
      criterion_id: "capability-contract-output",
      description: `Return a result conforming to ${candidate.capability_id} ${candidate.capability_version}.`,
      required: true,
      result_schema_ref: contract.output_schema?.uri ?? null,
      required_evidence_types: [],
      extensions: {
        "workfabric.dev/contract_digest": candidate.contract_digest,
      },
    }],
    verifier,
    priority: "normal",
    accept_by: request.deadline,
    result_due_at: request.deadline,
  };
}

function commandOptions(
  request: CapabilityInvocationRequest,
  action: "offer" | "resolve",
  signal: AbortSignal,
): NewCommandOptions {
  return {
    idempotencyKey: commandKey(request, action),
    correlationId: request.original_handoff_id,
    causationId: request.original_handoff_id,
    signal,
  };
}

export class HandoffCapabilityInvocationPort
  implements CapabilityInvocationPort {
  private readonly now: () => string;
  private readonly leaseSeconds: number;

  constructor(
    private readonly dependencies: HandoffCapabilityInvocationDependencies,
  ) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.leaseSeconds = dependencies.lease_seconds ?? 86_400;
  }

  discover(
    requirement: Parameters<CapabilityInvocationPort["discover"]>[0],
    signal?: AbortSignal,
  ): Promise<readonly CapabilityCandidate[]> {
    return this.dependencies.resolver.discover(requirement, signal);
  }

  async invoke(
    input: CapabilityInvocationRequest,
    signal: AbortSignal,
  ): Promise<CapabilityInvocationResult> {
    const request = validateCapabilityInvocationRequest(input);
    const now = this.now();
    if (signal.aborted) {
      return failure(
        request,
        null,
        "capability_cancelled",
        "Capability invocation was cancelled",
        false,
      );
    }
    if (Date.parse(request.deadline) <= Date.parse(now)) {
      return failure(
        request,
        null,
        "capability_deadline_exceeded",
        "Capability invocation deadline has elapsed",
        false,
      );
    }

    const created = await this.dependencies.state.createInvocationIfAbsent({
      tenant_id: this.dependencies.tenant_id,
      request,
      request_digest: digest(request),
      now,
    });
    const existingTerminal = terminalResult(created.record);
    if (existingTerminal !== null) return existingTerminal;

    const claimed = await this.dependencies.state.claimInvocation({
      tenant_id: this.dependencies.tenant_id,
      original_handoff_id: request.original_handoff_id,
      invocation_id: request.invocation_id,
      owner: this.dependencies.owner_id,
      now,
      lease_seconds: Math.max(
        1,
        Math.min(
          this.leaseSeconds,
          Math.ceil(
            (Date.parse(request.deadline) - Date.parse(now)) / 1_000,
          ) + 1,
        ),
      ),
      allowed_states: ["requested", "offered", "waiting"],
    });
    if (claimed === null) {
      const current = await this.dependencies.state.getInvocation(
        this.dependencies.tenant_id,
        request.original_handoff_id,
        request.invocation_id,
      );
      const result = current === null ? null : terminalResult(current);
      if (result !== null) return result;
      throw new Error("Capability invocation is owned by another runtime");
    }

    try {
      return await this.run(request, claimed, signal);
    } catch (error) {
      const current = await this.dependencies.state.getInvocation(
        this.dependencies.tenant_id,
        request.original_handoff_id,
        request.invocation_id,
      );
      const terminal = current === null ? null : terminalResult(current);
      if (terminal !== null) return terminal;
      const result = failure(
        request,
        current?.auxiliary_handoff_id ?? claimed.auxiliary_handoff_id,
        signal.aborted ? "capability_cancelled" : "capability_invocation_failed",
        signal.aborted
          ? "Capability invocation was cancelled"
          : error instanceof Error
            ? error.message.slice(0, 8_192)
            : "Capability invocation failed",
        !signal.aborted,
      );
      await this.finish(claimed, current?.state ?? claimed.state, result);
      return result;
    }
  }

  private async run(
    request: CapabilityInvocationRequest,
    claimed: CapabilityInvocationRecord,
    signal: AbortSignal,
  ): Promise<CapabilityInvocationResult> {
    let state = claimed.state;
    let candidate = claimed.candidate;
    let auxiliaryHandoffId = claimed.auxiliary_handoff_id;
    let contract: BoundCapabilityContract;

    if (candidate === null) {
      const candidates = await this.dependencies.resolver.discover({
        capability_id: request.capability_id,
        version_constraint: request.version_constraint,
      }, signal);
      if (candidates.length === 0) {
        const result = failure(
          request,
          null,
          "capability_unavailable",
          "No authorized compatible capability Provider is available",
          true,
        );
        await this.finish(claimed, state, result);
        return result;
      }
      candidate = candidates[0]!;
      contract = await this.dependencies.resolver.getBoundContract(
        candidate,
        signal,
      );
      await this.dependencies.schemas.validateInput(
        contract,
        request.input,
        signal,
      );
      const authorityScope = await this.dependencies.authority.authorize({
        tenant_id: this.dependencies.tenant_id,
        request,
        candidate,
        contract,
        work_reference_uri: workReference(request),
      }, signal);
      const offered = acceptedResource(await this.dependencies.handoffs.offer(
        offerPayload(
          request,
          candidate,
          contract,
          authorityScope,
          this.dependencies.verifier,
        ),
        commandOptions(request, "offer", signal),
      ));
      auxiliaryHandoffId = offered.resource_id;
      await this.transition(claimed, state, "offered", {
        candidate,
        auxiliary_handoff_id: auxiliaryHandoffId,
      });
      state = "offered";
      await this.resolve(
        request,
        candidate,
        auxiliaryHandoffId,
        offered.resource_version,
        signal,
      );
      await this.transition(claimed, state, "waiting");
      state = "waiting";
    } else {
      contract = await this.dependencies.resolver.getBoundContract(
        candidate,
        signal,
      );
      if (auxiliaryHandoffId === null) {
        throw new Error("Persisted capability binding is incomplete");
      }
      if (state === "offered") {
        const snapshot = await this.dependencies.handoffs.getHandoff(
          auxiliaryHandoffId,
          { signal },
        );
        if (snapshot.state.lifecycle_state === "target_resolution_pending") {
          await this.resolve(
            request,
            candidate,
            auxiliaryHandoffId,
            snapshot.stream_version,
            signal,
          );
        }
        await this.transition(claimed, state, "waiting");
        state = "waiting";
      }
    }

    if (candidate === null || auxiliaryHandoffId === null) {
      throw new Error("Capability binding was not persisted");
    }
    const terminal = await this.dependencies.waiter.wait({
      tenant_id: this.dependencies.tenant_id,
      original_handoff_id: request.original_handoff_id,
      auxiliary_handoff_id: auxiliaryHandoffId,
      invocation_id: request.invocation_id,
      candidate,
      contract,
      deadline: request.deadline,
    }, signal);
    if (terminal.outcome !== "succeeded") {
      const result = terminalFailure(request, auxiliaryHandoffId, terminal);
      await this.finish(claimed, state, result);
      return result;
    }
    let normalized;
    try {
      normalized = await this.dependencies.schemas.validateOutput(
        contract,
        terminal.data,
        terminal.artifacts,
        signal,
      );
    } catch {
      const result = failure(
        request,
        auxiliaryHandoffId,
        "capability_output_invalid",
        "Capability Provider output does not match the bound contract",
        false,
      );
      await this.finish(claimed, state, result);
      return result;
    }
    const result = validateCapabilityInvocationResult({
      outcome: "succeeded",
      invocation_id: request.invocation_id,
      auxiliary_handoff_id: auxiliaryHandoffId,
      candidate,
      data: normalized.data,
      artifacts: normalized.artifacts,
    });
    await this.finish(claimed, state, result);
    return result;
  }

  private async resolve(
    request: CapabilityInvocationRequest,
    candidate: CapabilityCandidate,
    handoffId: string,
    expectedVersion: number,
    signal: AbortSignal,
  ): Promise<void> {
    const payload = {
      handoff_id: handoffId,
      resolved_target: { endpoint_id: candidate.endpoint_id },
      evidence: [{
        evidence_id: bindingEvidenceId(request),
        evidence_type: "contract_binding",
        content: {
          kind: "data",
          schema_ref:
            "urn:work-fabric:schema:network-citizen-contract-binding:1",
          data: {
            citizen_id: candidate.citizen_id,
            declaration_id: candidate.capability_id,
            declaration_version: candidate.capability_version,
            contract_digest: candidate.contract_digest,
          },
        },
      }],
    };
    const options: ExistingHandoffCommandOptions = {
      ...commandOptions(request, "resolve", signal),
      expectedVersion,
    };
    const result = await this.dependencies.handoffs.resolveTarget(
      payload,
      options,
    );
    if (result.operation_status === "accepted") return;
    if (result.operation_status !== "conflict") {
      throw new Error(`Handoff target resolution ${result.operation_status}`);
    }
    const current = await this.dependencies.handoffs.getHandoff(
      handoffId,
      { signal },
    );
    if (current.state.lifecycle_state !== "target_resolution_pending") return;
    const retry = await this.dependencies.handoffs.resolveTarget(payload, {
      ...options,
      expectedVersion: current.stream_version,
    });
    if (retry.operation_status !== "accepted") {
      throw new Error(`Handoff target resolution ${retry.operation_status}`);
    }
  }

  private transition(
    claimed: CapabilityInvocationRecord,
    expectedState: CapabilityInvocationRecord["state"],
    nextState: CapabilityInvocationRecord["state"],
    extra: {
      readonly candidate?: CapabilityCandidate;
      readonly auxiliary_handoff_id?: string;
      readonly result?: CapabilityInvocationResult;
    } = {},
  ): Promise<boolean> {
    return this.dependencies.state.transitionInvocation({
      tenant_id: this.dependencies.tenant_id,
      original_handoff_id: claimed.original_handoff_id,
      invocation_id: claimed.invocation_id,
      owner: this.dependencies.owner_id,
      fencing_token: claimed.fencing_token,
      expected_state: expectedState,
      next_state: nextState,
      now: this.now(),
      ...extra,
    });
  }

  private async finish(
    claimed: CapabilityInvocationRecord,
    state: CapabilityInvocationRecord["state"],
    result: CapabilityInvocationResult,
  ): Promise<void> {
    const transitioned = await this.transition(
      claimed,
      state,
      result.outcome,
      { result },
    );
    if (!transitioned) {
      throw new Error("Capability invocation fencing conflict");
    }
  }
}
