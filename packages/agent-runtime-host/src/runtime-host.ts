import { createHash } from "node:crypto";

import type {
  AgentRuntimeDriver,
  AgentRuntimeStateStore,
  RuntimeDriverResult,
  RuntimeProgress,
  RuntimeRunRecord,
  RuntimeRunState,
} from "@work-fabric/agent-runtime-spi";
import type { AgentEndpointSession, IncomingHandoff } from "@work-fabric/agent-gateway";
import type { HandoffReadModel, OperationResult, ProtocolEvent } from "@work-fabric/sdk-typescript";

import { type AcceptanceDecision } from "./acceptance-policy.js";
import { AgentRuntimeHostError, invalid } from "./errors.js";
import { HandoffPackageLoader, type RuntimeHandoffQueries } from "./handoff-package-loader.js";
import { runtimeCommandKey, type RuntimeCommand } from "./idempotency.js";
import { ProgressCoalescer } from "./progress-coalescer.js";
import { resultPayload, statusPayload } from "./protocol-mapping.js";
import { workspacePath } from "./workspace-locator.js";

export interface AgentRuntimeHostConfig {
  readonly runtime_id: string;
  readonly tenant_id: string;
  readonly actor_id: string;
  readonly endpoint_id: string;
  readonly max_active_runs: number;
  readonly queue_capacity: number;
  readonly run_lease_seconds: number;
  readonly progress_interval_ms: number;
  readonly workspace_root: string;
}

export interface RuntimeAcceptancePolicy {
  decide(
    snapshot: HandoffReadModel,
    event: ProtocolEvent,
    alreadyRunning: boolean,
  ): AcceptanceDecision;
}

export interface AgentRuntimeHostDependencies {
  readonly config: AgentRuntimeHostConfig;
  readonly session?: AgentEndpointSession;
  /** Used by runnable composition so opening the Gateway is part of start(). */
  readonly startSession?: () => Promise<AgentEndpointSession>;
  readonly state: AgentRuntimeStateStore;
  readonly driver: AgentRuntimeDriver;
  readonly packageLoader: Pick<HandoffPackageLoader, "load">;
  readonly policy: RuntimeAcceptancePolicy;
  readonly queries: Pick<RuntimeHandoffQueries, "getHandoff">;
  readonly now?: () => string;
  readonly close_grace_ms?: number;
}

const TERMINAL_LIFECYCLES = new Set([
  "cancelled", "expired", "declined", "result_returned", "verified", "closed", "transferred", "target_unavailable",
]);
const CANCELLING_LIFECYCLES = new Set([
  "cancelled", "expired", "declined", "transferred", "target_unavailable",
]);

function lifecycle(snapshot: HandoffReadModel): string | null {
  const state = snapshot.state;
  if (typeof state !== "object" || state === null || Array.isArray(state)) return null;
  const value = (state as Record<string, unknown>).lifecycle_state;
  return typeof value === "string" ? value : null;
}

function resourceVersion(snapshot: HandoffReadModel): number {
  if (!Number.isSafeInteger(snapshot.stream_version) || snapshot.stream_version < 1) {
    throw new AgentRuntimeHostError("invalid_snapshot", "stream_version");
  }
  return snapshot.stream_version;
}

function acceptedVersion(result: OperationResult, fallback: number): number {
  const value = result.resource !== null && typeof result.resource === "object"
    ? (result.resource as Record<string, unknown>).resource_version
    : undefined;
  return Number.isSafeInteger(value) && (value as number) >= 1 ? value as number : fallback;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const item = value as Record<string, unknown>;
  return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`).join(",")}}`;
}

function digest(result: RuntimeDriverResult): string {
  return createHash("sha256").update(canonical(result)).digest("hex");
}

function remoteResult(snapshot: HandoffReadModel): RuntimeDriverResult | null {
  if (typeof snapshot.state !== "object" || snapshot.state === null || Array.isArray(snapshot.state)) return null;
  const result = (snapshot.state as Record<string, unknown>).result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) return null;
  // The public Handoff state is authoritative only if it is still a valid
  // Runtime Result payload; do not manufacture a local success from malformed
  // projection data.
  resultPayload(snapshot.handoff_id, result as RuntimeDriverResult);
  return result as RuntimeDriverResult;
}

function deliveryEvent(incoming: IncomingHandoff): ProtocolEvent {
  const event = incoming.delivery.events.find((candidate) => candidate.wfhandoff === incoming.handoff.handoff_id);
  if (event === undefined) throw new AgentRuntimeHostError("invalid_delivery", incoming.delivery.delivery_id);
  return event;
}

function boundedFailure(error: unknown): string {
  if (error instanceof AgentRuntimeHostError) return error.code.slice(0, 64);
  return "driver_failed";
}

export class AgentRuntimeHost {
  private session: AgentEndpointSession | null;
  private readonly now: () => string;
  private readonly closeGraceMs: number;
  private readonly shutdown = new AbortController();
  private readonly active = new Map<string, AbortController>();
  private readonly pending: IncomingHandoff[] = [];
  private running = 0;
  private intake: Promise<void> | null = null;
  private starting: Promise<void> | null = null;
  private started = false;
  private closing = false;

  constructor(private readonly dependencies: AgentRuntimeHostDependencies) {
    this.validateConfig(dependencies.config);
    if (dependencies.session === undefined && dependencies.startSession === undefined) invalid("invalid_runtime_host", "session");
    this.session = dependencies.session ?? null;
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.closeGraceMs = dependencies.close_grace_ms ?? 10_000;
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.starting !== null) return this.starting;
    const start = this.startInternal();
    this.starting = start;
    try {
      await start;
    } finally {
      if (!this.started) this.starting = null;
    }
  }

  private async startInternal(): Promise<void> {
    let createdSession: AgentEndpointSession | null = null;
    try {
      if (this.session === null) {
        createdSession = await this.dependencies.startSession!();
        this.session = createdSession;
      }
      await this.recover();
      if (this.closing) throw new AgentRuntimeHostError("runtime_closing", this.dependencies.config.runtime_id);
      this.intake = this.consume();
      this.started = true;
    } catch (cause) {
      this.intake = null;
      this.started = false;
      if (createdSession !== null) {
        this.session = null;
        try { await createdSession.close(); } catch { /* preserve startup failure */ }
      }
      throw cause;
    }
  }

  async handle(incoming: IncomingHandoff): Promise<void> {
    const signal = this.shutdown.signal;
    const event = deliveryEvent(incoming);
    const receipt = await this.dependencies.state.recordDelivery({
      tenant_id: this.dependencies.config.tenant_id,
      delivery_id: incoming.delivery.delivery_id,
      handoff_id: incoming.handoff.handoff_id,
      partition_id: incoming.partition_id,
      event_id: event.id,
      received_at: this.now(),
      acknowledged_at: null,
    });
    // A service Ack releases the Delivery for good, but it is not an
    // acceptance of responsibility.  Create the local Run before that Ack so
    // a process failure in the interval leaves durable custody for recovery.
    const captured = await this.dependencies.state.createRunIfAbsent(
      this.dependencies.config.tenant_id,
      incoming.handoff.handoff_id,
      this.now(),
    );
    const acknowledgement = await incoming.acknowledgeSignal("acknowledged");
    if (acknowledgement.kind !== "acknowledged") throw new AgentRuntimeHostError("delivery_ack_failed", incoming.delivery.delivery_id);
    await this.dependencies.state.markDeliveryAcknowledged(
      this.dependencies.config.tenant_id,
      incoming.delivery.delivery_id,
      this.now(),
    );
    // A queue-full path durably records a receipt then asks the Gateway to
    // retry it.  That receipt has no acknowledgement timestamp and must be
    // allowed to enter the lifecycle on the retry Delivery.
    if (!receipt.created && receipt.record.acknowledged_at !== null) return;

    const terminal = lifecycle(incoming.handoff);
    if (terminal !== null && TERMINAL_LIFECYCLES.has(terminal)) {
      const active = this.active.get(incoming.handoff.handoff_id);
      if (active !== undefined) active.abort();
      else {
        const run = await this.dependencies.state.getRun(
          this.dependencies.config.tenant_id,
          incoming.handoff.handoff_id,
        );
        if (run !== null) await this.convergeTerminal(run, terminal, incoming.handoff);
      }
      return;
    }
    const decision = this.dependencies.policy.decide(
      incoming.handoff,
      event,
      captured.run.state !== "received",
    );
    if (decision.kind === "ignore") return;
    if (decision.kind === "decline") {
      await this.issueDecline(incoming.handoff.handoff_id, incoming.handoff, signal);
      const claim = await this.claim(incoming.handoff.handoff_id, ["received"]);
      if (claim !== null) await this.transition(claim, "received", "cancelled");
      return;
    }
    await this.claimAndRun(incoming.handoff.handoff_id, incoming.handoff, signal);
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.shutdown.abort();
    for (const controller of this.active.values()) controller.abort();
    await Promise.race([
      this.waitForActive(),
      new Promise<void>((resolve) => setTimeout(resolve, this.closeGraceMs)),
    ]);
    try {
      if (this.session !== null) await this.session.close();
    } finally {
      await this.dependencies.state.close();
    }
  }

  private async consume(): Promise<void> {
    const session = this.requireSession();
    try {
      for await (const incoming of session.incoming()) {
        if (this.closing) break;
        const remoteLifecycle = lifecycle(incoming.handoff);
        // A terminal Delivery is control-plane work, not queued execution.
        // Dispatch it immediately so it can abort an active external Driver
        // even while the normal execution capacity is saturated.
        if (remoteLifecycle !== null && TERMINAL_LIFECYCLES.has(remoteLifecycle)) {
          void this.handle(incoming).catch(() => undefined);
          continue;
        }
        if (this.running + this.pending.length >= this.dependencies.config.max_active_runs + this.dependencies.config.queue_capacity) {
          await this.persistAndRetry(incoming);
          continue;
        }
        this.pending.push(incoming);
        this.drain();
      }
    } catch {
      // The Gateway owns transport recovery. A later process restart replays durable deliveries.
    }
  }

  private drain(): void {
    while (!this.closing && this.running < this.dependencies.config.max_active_runs && this.pending.length > 0) {
      const incoming = this.pending.shift()!;
      this.running += 1;
      void this.handle(incoming).catch(() => undefined).finally(() => {
        this.running -= 1;
        this.drain();
      });
    }
  }

  private async persistAndRetry(incoming: IncomingHandoff): Promise<void> {
    const event = deliveryEvent(incoming);
    await this.dependencies.state.recordDelivery({
      tenant_id: this.dependencies.config.tenant_id,
      delivery_id: incoming.delivery.delivery_id,
      handoff_id: incoming.handoff.handoff_id,
      partition_id: incoming.partition_id,
      event_id: event.id,
      received_at: this.now(),
      acknowledged_at: null,
    });
    const acknowledgement = await incoming.acknowledgeSignal("retry");
    if (acknowledgement.kind !== "retry") {
      throw new AgentRuntimeHostError("delivery_retry_failed", incoming.delivery.delivery_id);
    }
  }

  private async recover(): Promise<void> {
    const runs = await this.dependencies.state.listRecoverable(
      this.dependencies.config.tenant_id,
      this.now(),
      this.dependencies.config.queue_capacity,
    );
    for (const run of runs) {
      if (this.closing) return;
      const snapshot = await this.dependencies.queries.getHandoff(run.handoff_id, { signal: this.shutdown.signal });
      const remote = lifecycle(snapshot);
      if (remote !== null && TERMINAL_LIFECYCLES.has(remote)) {
        await this.convergeTerminal(run, remote, snapshot);
      } else if (run.state === "result_ready" && run.result !== null) {
        const claim = await this.claim(run.handoff_id, ["result_ready"]);
        if (claim !== null) await this.submitReadyResult(run.handoff_id, claim, this.shutdown.signal);
      } else if (remote === "accepted" && (run.state === "accepted" || run.state === "running" || run.state === "received")) {
        await this.claimAndRun(run.handoff_id, snapshot, this.shutdown.signal);
      } else if (remote === "offered" && run.state === "received") {
        const recoveredEvent = { type: "workfabric.handoff.offered.v1", wfactor: "" } as ProtocolEvent;
        const decision = this.dependencies.policy.decide(snapshot, recoveredEvent, false);
        if (decision.kind === "accept") await this.claimAndRun(run.handoff_id, snapshot, this.shutdown.signal);
        else if (decision.kind === "decline") {
          await this.issueDecline(run.handoff_id, snapshot, this.shutdown.signal);
          const claim = await this.claim(run.handoff_id, ["received"]);
          if (claim !== null) await this.transition(claim, "received", "cancelled");
        }
      }
    }
  }

  private async convergeTerminal(
    run: RuntimeRunRecord,
    remote: string,
    snapshot: HandoffReadModel,
  ): Promise<void> {
    const claim = await this.claim(run.handoff_id, [run.state]);
    if (claim === null) return;
    if (["result_returned", "verified", "closed"].includes(remote)) {
      const result = remoteResult(snapshot);
      if (result === null) throw new AgentRuntimeHostError("invalid_remote_result", run.handoff_id);
      await this.convergeResult(claim, result);
      return;
    }
    await this.transition(claim, run.state, "cancelled");
  }

  private async convergeResult(claim: RuntimeRunRecord, result: RuntimeDriverResult): Promise<void> {
    let state = claim.state;
    if (state === "received") {
      await this.transition(claim, "received", "accepted");
      state = "accepted";
    }
    if (state === "accepted") {
      await this.transition(claim, "accepted", "running");
      state = "running";
    }
    if (state === "running") {
      await this.transition(claim, "running", "result_ready", result);
      state = "result_ready";
    }
    if (state === "result_ready") await this.transition(claim, "result_ready", "succeeded");
  }

  private async claimAndRun(handoffId: string, snapshot: HandoffReadModel, signal: AbortSignal): Promise<void> {
    const claim = await this.claim(handoffId, ["received", "accepted", "running", "result_ready"]);
    if (claim === null) return;
    if (claim.state === "result_ready") {
      await this.submitReadyResult(handoffId, claim, signal);
      return;
    }
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    this.active.get(handoffId)?.abort();
    this.active.set(handoffId, controller);
    const stopLeaseRenewal = this.renewLease(claim, controller);
    let state: RuntimeRunState = claim.state;
    let lastProgress = claim.last_progress_sequence;
    let coalescer: ProgressCoalescer | null = null;
    try {
      const loaded = await this.dependencies.packageLoader.load(
        handoffId,
        workspacePath(this.dependencies.config.workspace_root, this.dependencies.config.tenant_id, handoffId),
        combined,
      );
      if (state === "received") {
        await this.issueAccept(handoffId, loaded.snapshot, combined);
        await this.transition(claim, "received", "accepted");
        state = "accepted";
      }
      if (state === "accepted") {
        if (claim.last_progress_sequence < 1) {
          const initial: RuntimeProgress = { sequence: 1, progress: 0, message: "Agent Runtime started", observed_at: this.now() };
          await this.issueStatus(handoffId, initial, combined);
          const checkpointed = await this.dependencies.state.checkpointProgress({ tenant_id: this.dependencies.config.tenant_id, handoff_id: handoffId, owner: this.dependencies.config.runtime_id, fencing_token: claim.fencing_token, sequence: 1, now: this.now() });
          if (!checkpointed) throw new AgentRuntimeHostError("run_fenced", handoffId);
          lastProgress = 1;
        }
        await this.transition(claim, "accepted", "running");
        state = "running";
      }
      const progressOffset = Math.max(1, claim.last_progress_sequence);
      coalescer = new ProgressCoalescer(this.dependencies.config.progress_interval_ms, async (update) => {
        await this.issueStatus(handoffId, update, combined);
        const checkpointed = await this.dependencies.state.checkpointProgress({ tenant_id: this.dependencies.config.tenant_id, handoff_id: handoffId, owner: this.dependencies.config.runtime_id, fencing_token: claim.fencing_token, sequence: update.sequence, now: this.now() });
        if (!checkpointed) throw new AgentRuntimeHostError("run_fenced", handoffId);
        lastProgress = update.sequence;
      });
      const result = await this.dependencies.driver.execute(loaded.task, (update) => coalescer!.push({ ...update, sequence: update.sequence + progressOffset }), combined);
      await coalescer.flush();
      // Validate before making the durable result-ready transition.
      resultPayload(handoffId, result);
      await this.transition(claim, "running", "result_ready", result);
      state = "result_ready";
      await this.issueResult(handoffId, result, combined);
      await this.transition(claim, "result_ready", "succeeded");
    } catch (error) {
      try { await coalescer?.flush(); } catch { /* a fenced run cannot safely publish further progress */ }
      if (state === "result_ready" && !combined.aborted) {
        // Result persistence has succeeded.  A failure while submitting (or
        // confirming) the external Result is ambiguous, so retain it for a
        // later owner to replay with the same idempotency key.
        return;
      }
      if (combined.aborted) {
        await this.tryTransition(claim, state, "cancelled");
      } else {
        // A remote cancellation may win between the Driver's local progress
        // update and its command reaching Work Fabric. A failed status write
        // is not a failed execution in that case: re-read the public Handoff
        // and converge the currently owned local run before reporting failure.
        if (await this.convergeRemoteCancellation(claim, handoffId)) return;
        try {
          const failureProgress: RuntimeProgress = { sequence: lastProgress + 1, progress: null, message: "Agent Runtime failed", observed_at: this.now() };
          await this.issueStatus(handoffId, failureProgress, combined);
          await this.dependencies.state.checkpointProgress({ tenant_id: this.dependencies.config.tenant_id, handoff_id: handoffId, owner: this.dependencies.config.runtime_id, fencing_token: claim.fencing_token, sequence: failureProgress.sequence, now: this.now() });
        } catch { /* preserve the original execution failure and local terminal transition */ }
        await this.tryTransition(claim, state, "failed", boundedFailure(error));
      }
    } finally {
      stopLeaseRenewal();
      if (this.active.get(handoffId) === controller) this.active.delete(handoffId);
    }
  }

  private async submitReadyResult(handoffId: string, claim: RuntimeRunRecord, signal: AbortSignal): Promise<void> {
    if (claim.result === null) throw new AgentRuntimeHostError("missing_result", handoffId);
    try {
      resultPayload(handoffId, claim.result);
      await this.issueResult(handoffId, claim.result, signal);
      await this.transition(claim, "result_ready", "succeeded");
    } catch {
      // The command may have reached Work Fabric even when its response was
      // lost. Keep the validated durable Result and let a later lease holder
      // replay the same idempotency key; only an authoritative terminal
      // Delivery is allowed to dispose of result_ready.
    }
  }

  private async convergeRemoteCancellation(
    claim: RuntimeRunRecord,
    handoffId: string,
  ): Promise<boolean> {
    try {
      const remote = await this.dependencies.queries.getHandoff(handoffId, {
        signal: this.shutdown.signal,
      });
      const remoteLifecycle = lifecycle(remote);
      if (remoteLifecycle === null || !CANCELLING_LIFECYCLES.has(remoteLifecycle)) return false;
      const current = await this.dependencies.state.getRun(
        this.dependencies.config.tenant_id,
        handoffId,
      );
      if (current === null) return false;
      if (["succeeded", "failed", "cancelled"].includes(current.state)) return true;
      await this.tryTransition(claim, current.state, "cancelled");
      const converged = await this.dependencies.state.getRun(
        this.dependencies.config.tenant_id,
        handoffId,
      );
      return converged?.state === "cancelled";
    } catch {
      // Preserve the original execution error if the public control plane is
      // unavailable; recovery will make the same authoritative check later.
      return false;
    }
  }

  private async claim(handoffId: string, allowed: readonly RuntimeRunState[]): Promise<RuntimeRunRecord | null> {
    return this.dependencies.state.claimRun({ tenant_id: this.dependencies.config.tenant_id, handoff_id: handoffId, owner: this.dependencies.config.runtime_id, now: this.now(), lease_seconds: this.dependencies.config.run_lease_seconds, allowed_states: allowed });
  }

  private async transition(claim: RuntimeRunRecord, expected: RuntimeRunState, next: RuntimeRunState, result?: RuntimeDriverResult, failureCode?: string): Promise<void> {
    const changed = await this.dependencies.state.transitionRun({
      tenant_id: this.dependencies.config.tenant_id, handoff_id: claim.handoff_id, owner: this.dependencies.config.runtime_id, fencing_token: claim.fencing_token, expected_state: expected, next_state: next, now: this.now(),
      ...(result === undefined ? {} : { result, result_digest: digest(result) }),
      ...(failureCode === undefined ? {} : { failure_code: failureCode }),
    });
    if (!changed) throw new AgentRuntimeHostError("run_fenced", claim.handoff_id);
  }

  private async tryTransition(claim: RuntimeRunRecord, expected: RuntimeRunState, next: RuntimeRunState, failureCode?: string): Promise<void> {
    try { await this.transition(claim, expected, next, undefined, failureCode); } catch { /* no longer responsible */ }
  }

  private async issueDecline(handoffId: string, _snapshot: HandoffReadModel, signal: AbortSignal): Promise<void> {
    await this.issueCommand("decline", handoffId, 0, signal, async (snapshot, options) => this.requireSession().handoffs.decline({ handoff_id: handoffId }, options), (current) => lifecycle(current) === "declined");
  }

  private async issueAccept(handoffId: string, _snapshot: HandoffReadModel, signal: AbortSignal): Promise<void> {
    await this.issueCommand("accept", handoffId, 0, signal, async (_snapshot, options) => this.requireSession().handoffs.accept({ handoff_id: handoffId }, options), (current) => {
      const state = current.state as Record<string, unknown>;
      const recipient = state.recipient as Record<string, unknown> | null;
      return ["accepted", "result_returned", "verified", "closed"].includes(lifecycle(current) ?? "") && recipient !== null && recipient.actor_id === this.dependencies.config.actor_id;
    });
  }

  private async issueStatus(handoffId: string, progress: RuntimeProgress, signal: AbortSignal): Promise<void> {
    const payload = statusPayload(handoffId, progress);
    await this.issueCommand("status", handoffId, progress.sequence, signal, async (_snapshot, options) => this.requireSession().handoffs.reportStatus(payload, options), (current) => {
      const latest = current.latest_status as Record<string, unknown> | null;
      const status = payload.status as Record<string, unknown>;
      return latest !== null && latest.status_report_id === status.status_report_id;
    });
  }

  private async issueResult(handoffId: string, result: RuntimeDriverResult, signal: AbortSignal): Promise<void> {
    const payload = resultPayload(handoffId, result);
    await this.issueCommand("result", handoffId, 0, signal, async (_snapshot, options) => this.requireSession().handoffs.returnResult(payload, options), (current) => {
      const state = current.state as Record<string, unknown>;
      return ["result_returned", "verified", "closed"].includes(lifecycle(current) ?? "") && canonical(state.result) === canonical(payload.result);
    });
  }

  private async issueCommand(
    command: RuntimeCommand,
    handoffId: string,
    sequence: number,
    signal: AbortSignal,
    send: (snapshot: HandoffReadModel, options: { readonly expectedVersion: number; readonly idempotencyKey: string; readonly signal: AbortSignal }) => Promise<OperationResult>,
    equivalent: (snapshot: HandoffReadModel) => boolean,
  ): Promise<void> {
    const key = runtimeCommandKey(this.dependencies.config.runtime_id, handoffId, command, sequence);
    const recorded = await this.dependencies.state.listCommands(this.dependencies.config.tenant_id, handoffId);
    if (recorded.some((item) => item.idempotency_key === key && item.command === command)) return;
    const snapshot = await this.dependencies.queries.getHandoff(handoffId, { signal });
    const expectedVersion = resourceVersion(snapshot);
    const response = await send(snapshot, { expectedVersion, idempotencyKey: key, signal });
    if (response.operation_status === "accepted") {
      await this.recordCommand(handoffId, command, key, acceptedVersion(response, expectedVersion));
      return;
    }
    if (response.operation_status === "conflict") {
      const current = await this.dependencies.queries.getHandoff(handoffId, { signal });
      if (equivalent(current)) {
        await this.recordCommand(handoffId, command, key, resourceVersion(current));
        return;
      }
    }
    throw new AgentRuntimeHostError("command_not_converged", `${command}:${handoffId}`);
  }

  private async recordCommand(handoffId: string, command: RuntimeCommand, key: string, version: number): Promise<void> {
    await this.dependencies.state.recordCommand({ tenant_id: this.dependencies.config.tenant_id, handoff_id: handoffId, command, idempotency_key: key, resource_version: version, recorded_at: this.now() });
  }

  private renewLease(claim: RuntimeRunRecord, controller: AbortController): () => void {
    // Renew halfway through even the smallest permitted one-second lease.
    // A 1000ms floor renews at (or after) expiry once timer scheduling jitter
    // is included, which correctly fences the old owner but needlessly aborts
    // a healthy run.
    const period = Math.max(1, Math.floor(this.dependencies.config.run_lease_seconds * 500));
    const timer = setInterval(() => {
      void this.dependencies.state.renewRun(
        this.dependencies.config.tenant_id,
        claim.handoff_id,
        this.dependencies.config.runtime_id,
        claim.fencing_token,
        this.now(),
        this.dependencies.config.run_lease_seconds,
      ).then((renewed) => {
        if (!renewed) controller.abort();
      }, () => controller.abort());
    }, period);
    return () => clearInterval(timer);
  }

  private requireSession(): AgentEndpointSession {
    if (this.session === null) throw new AgentRuntimeHostError("runtime_not_started", "session");
    return this.session;
  }

  private async waitForActive(): Promise<void> {
    while (this.active.size > 0 || this.running > 0) await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }

  private validateConfig(config: AgentRuntimeHostConfig): void {
    for (const [field, value] of Object.entries({ runtime_id: config.runtime_id, tenant_id: config.tenant_id, actor_id: config.actor_id, endpoint_id: config.endpoint_id, workspace_root: config.workspace_root })) {
      if (typeof value !== "string" || value.length === 0 || value.trim() !== value) invalid("invalid_runtime_host", field);
    }
    for (const [field, value] of Object.entries({ max_active_runs: config.max_active_runs, queue_capacity: config.queue_capacity, run_lease_seconds: config.run_lease_seconds, progress_interval_ms: config.progress_interval_ms })) {
      if (!Number.isSafeInteger(value) || value < 1) invalid("invalid_runtime_host", field);
    }
  }
}
