import {
  ConnectorIngressStoreError,
  type ConnectorCommandResult,
  type ConnectorCommandSink,
  type ConnectorEventMapper,
  type ConnectorIngressClaim,
  type ConnectorIngressStore,
  type ConnectorMappingOutcome,
  type ConnectorObservationSink,
} from "@work-fabric/connector-spi";
import { parseUtcTimestamp } from "@work-fabric/exchange-spi";

import { ConnectorWorkerError } from "./errors.js";

export interface ConnectorWorkerClock {
  now(): string;
}

export interface ConnectorRetryPolicy {
  nextAvailableAt(attempt: number, errorCode: string, now: string): string;
}

export interface ConnectorWorkerScope {
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly worker_id: string;
  readonly lease_seconds: number;
  readonly batch_limit: number;
  readonly max_attempts: number;
  readonly max_error_detail_length: number;
}

export type ConnectorWorkerOutcome =
  | "completed"
  | "retried"
  | "dead_lettered"
  | "fenced";

export interface ConnectorWorkerObserver {
  record(outcome: ConnectorWorkerOutcome): void;
}

export interface ConnectorWorkerOptions {
  readonly store: ConnectorIngressStore;
  readonly mapper: ConnectorEventMapper;
  readonly command_sink: ConnectorCommandSink;
  readonly observation_sink: ConnectorObservationSink;
  readonly clock: ConnectorWorkerClock;
  readonly retry_policy: ConnectorRetryPolicy;
  readonly scope: ConnectorWorkerScope;
  readonly observer?: ConnectorWorkerObserver;
}

export interface ConnectorWorkerBatchResult {
  readonly claimed: number;
  readonly completed: number;
  readonly retried: number;
  readonly dead_lettered: number;
  readonly fenced: number;
}

interface ClassifiedFailure {
  readonly retryable: boolean;
  readonly error_code: string;
  readonly detail?: string;
}

function validatePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function sanitizeDetail(
  detail: string | undefined,
  maximum: number,
): string | undefined {
  if (detail === undefined || detail.length === 0) return undefined;
  return detail.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, maximum);
}

function classifyThrown(
  error: unknown,
  maximumDetail: number,
): ClassifiedFailure {
  if (error instanceof ConnectorWorkerError) {
    const detail = sanitizeDetail(error.safe_detail, maximumDetail);
    return {
      retryable: error.retryable,
      error_code: error.code,
      ...(detail === undefined ? {} : { detail }),
    };
  }
  return {
    retryable: true,
    error_code: "connector_unexpected_failure",
  };
}

function classifyResult(
  result: Exclude<ConnectorCommandResult, { readonly kind: "accepted" }>,
  maximumDetail: number,
): ClassifiedFailure {
  const detail = sanitizeDetail(result.detail, maximumDetail);
  return {
    retryable: result.kind === "retryable_failure",
    error_code: result.error_code,
    ...(detail === undefined ? {} : { detail }),
  };
}

export class ConnectorWorker {
  constructor(private readonly options: ConnectorWorkerOptions) {
    validatePositiveInteger(options.scope.lease_seconds, "lease_seconds");
    validatePositiveInteger(options.scope.batch_limit, "batch_limit");
    validatePositiveInteger(options.scope.max_attempts, "max_attempts");
    validatePositiveInteger(
      options.scope.max_error_detail_length,
      "max_error_detail_length",
    );
  }

  async runBatch(): Promise<ConnectorWorkerBatchResult> {
    const now = this.options.clock.now();
    parseUtcTimestamp(now, "Connector worker clock");
    const claims = await this.options.store.claim({
      tenant_id: this.options.scope.tenant_id,
      connector_id: this.options.scope.connector_id,
      worker_id: this.options.scope.worker_id,
      now,
      lease_seconds: this.options.scope.lease_seconds,
      limit: this.options.scope.batch_limit,
    });
    const counts = {
      claimed: claims.length,
      completed: 0,
      retried: 0,
      dead_lettered: 0,
      fenced: 0,
    };

    for (const claim of claims) {
      const outcome = await this.processClaim(claim);
      counts[outcome] += 1;
      this.options.observer?.record(outcome);
      if (outcome === "fenced") break;
    }
    return counts;
  }

  private async processClaim(
    claim: ConnectorIngressClaim,
  ): Promise<ConnectorWorkerOutcome> {
    let mapping: ConnectorMappingOutcome;
    try {
      mapping = await this.options.mapper.map(claim);
    } catch (error) {
      return this.settleFailure(
        claim,
        classifyThrown(error, this.options.scope.max_error_detail_length),
      );
    }

    if (mapping.kind === "rejected") {
      const detail = sanitizeDetail(
        mapping.detail,
        this.options.scope.max_error_detail_length,
      );
      return this.settleFailure(claim, {
        retryable: mapping.retryable,
        error_code: mapping.reason_code,
        ...(detail === undefined ? {} : { detail }),
      });
    }

    try {
      if (mapping.kind === "command") {
        const renewed = await this.renewBeforeSideEffect(claim);
        if (renewed === null) return "fenced";
        claim = renewed;
        const result = await this.options.command_sink.execute({
          tenant_id: claim.envelope.tenant_id,
          connector_id: claim.envelope.connector_id,
          ingress_id: claim.ingress_id,
          command: mapping.command,
        });
        if (result.kind !== "accepted") {
          return this.settleFailure(
            claim,
            classifyResult(
              result,
              this.options.scope.max_error_detail_length,
            ),
          );
        }
      } else if (
        mapping.kind === "reference_observed" ||
        mapping.kind === "reconciliation_observation"
      ) {
        const renewed = await this.renewBeforeSideEffect(claim);
        if (renewed === null) return "fenced";
        claim = renewed;
        const result = await this.options.observation_sink.record({
          tenant_id: claim.envelope.tenant_id,
          connector_id: claim.envelope.connector_id,
          ingress_id: claim.ingress_id,
          observation: mapping,
        });
        if (result.kind !== "accepted") {
          return this.settleFailure(
            claim,
            classifyResult(
              result,
              this.options.scope.max_error_detail_length,
            ),
          );
        }
      }
      await this.options.store.complete(this.claimMutation(claim));
      return "completed";
    } catch (error) {
      if (
        error instanceof ConnectorIngressStoreError &&
        error.code === "claim_lost"
      ) {
        return "fenced";
      }
      return this.settleFailure(
        claim,
        classifyThrown(error, this.options.scope.max_error_detail_length),
      );
    }
  }

  private async renewBeforeSideEffect(
    claim: ConnectorIngressClaim,
  ): Promise<ConnectorIngressClaim | null> {
    try {
      return await this.options.store.renew({
        ...this.claimMutation(claim),
        lease_seconds: this.options.scope.lease_seconds,
      });
    } catch (error) {
      if (
        error instanceof ConnectorIngressStoreError &&
        error.code === "claim_lost"
      ) return null;
      throw error;
    }
  }

  private async settleFailure(
    claim: ConnectorIngressClaim,
    failure: ClassifiedFailure,
  ): Promise<ConnectorWorkerOutcome> {
    try {
      const mutation = this.claimMutation(claim);
      if (!failure.retryable || claim.attempt >= this.options.scope.max_attempts) {
        await this.options.store.deadLetter({
          ...mutation,
          error_code: failure.error_code,
          ...(failure.detail === undefined
            ? {}
            : { error_detail: failure.detail }),
        });
        return "dead_lettered";
      }
      const availableAt = this.options.retry_policy.nextAvailableAt(
        claim.attempt,
        failure.error_code,
        mutation.now,
      );
      parseUtcTimestamp(availableAt, "Connector retry available_at");
      await this.options.store.retry({
        ...mutation,
        available_at: availableAt,
        error_code: failure.error_code,
        ...(failure.detail === undefined ? {} : { error_detail: failure.detail }),
      });
      return "retried";
    } catch (error) {
      if (
        error instanceof ConnectorIngressStoreError &&
        error.code === "claim_lost"
      ) {
        return "fenced";
      }
      throw error;
    }
  }

  private claimMutation(claim: ConnectorIngressClaim) {
    return {
      tenant_id: claim.envelope.tenant_id,
      connector_id: claim.envelope.connector_id,
      ingress_id: claim.ingress_id,
      claim_token: claim.claim_token,
      fencing_token: claim.fencing_token,
      now: this.options.clock.now(),
    };
  }
}
