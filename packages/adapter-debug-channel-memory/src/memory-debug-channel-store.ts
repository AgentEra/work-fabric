import { isDeepStrictEqual } from "node:util";
import {
  DebugChannelStoreError,
  assertDebugCapture,
  assertDebugSubmission,
  assertListDebugCaptures,
  assertPruneExpiredDebugRecords,
  debugChannelStoreManifest,
  type AppendDebugCapture,
  type CreateDebugSubmission,
  type CreateDebugSubmissionResult,
  type DebugCapture,
  type DebugCapturePage,
  type DebugCaptureScope,
  type DebugChannelStore,
  type DebugSubmission,
  type DebugSubmissionScope,
  type LinkDebugHandoff,
  type LinkDebugIngress,
  type ListDebugCaptures,
  type PruneExpiredDebugRecords,
} from "@work-fabric/debug-channel-spi";

const tuple = (...parts: readonly string[]) => parts.join("\0");

function submissionScopeKey(scope: DebugSubmissionScope): string {
  return tuple(scope.tenant_id, scope.plugin_instance_id, scope.submission_id);
}

function submissionIdentityKey(submission: DebugSubmission): string {
  return tuple(
    submission.tenant_id,
    submission.plugin_instance_id,
    submission.conversation_id,
    submission.idempotency_key,
  );
}

function captureScopeKey(scope: DebugCaptureScope): string {
  return tuple(scope.tenant_id, scope.plugin_instance_id, scope.capture_id);
}

function captureIdentityKey(capture: DebugCapture): string {
  return tuple(
    capture.tenant_id,
    capture.plugin_instance_id,
    capture.event_id,
    capture.destination_id,
  );
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryDebugChannelStore implements DebugChannelStore {
  readonly manifest = debugChannelStoreManifest("memory");
  private readonly submissions = new Map<string, DebugSubmission>();
  private readonly submissionIdentities = new Map<string, string>();
  private readonly captures = new Map<string, DebugCapture>();
  private readonly captureIdentities = new Map<string, string>();

  async createSubmission(
    input: CreateDebugSubmission,
  ): Promise<CreateDebugSubmissionResult> {
    assertDebugSubmission(input.submission);
    const candidate = clone(input.submission);
    const identityKey = submissionIdentityKey(candidate);
    const existingScope = this.submissionIdentities.get(identityKey);
    if (existingScope !== undefined) {
      const existing = this.submissions.get(existingScope)!;
      return {
        kind: existing.request_digest === candidate.request_digest
          ? "existing"
          : "conflict",
        submission: clone(existing),
      };
    }
    const scopeKey = submissionScopeKey(candidate);
    const existingByScope = this.submissions.get(scopeKey);
    if (existingByScope !== undefined) {
      return { kind: "conflict", submission: clone(existingByScope) };
    }
    this.submissions.set(scopeKey, candidate);
    this.submissionIdentities.set(identityKey, scopeKey);
    return { kind: "created", submission: clone(candidate) };
  }

  async linkIngress(input: LinkDebugIngress): Promise<DebugSubmission> {
    return this.link(input, "ingress_id", "ingress_conflict");
  }

  async linkHandoff(input: LinkDebugHandoff): Promise<DebugSubmission> {
    return this.link(input, "handoff_id", "handoff_conflict");
  }

  async getSubmission(
    scope: DebugSubmissionScope,
  ): Promise<DebugSubmission | null> {
    return clone(this.submissions.get(submissionScopeKey(scope)) ?? null);
  }

  async appendCapture(input: AppendDebugCapture): Promise<{
    readonly kind: "created" | "existing";
    readonly capture: DebugCapture;
  }> {
    assertDebugCapture(input.capture);
    const candidate = clone(input.capture);
    const identityKey = captureIdentityKey(candidate);
    const existingScope = this.captureIdentities.get(identityKey);
    if (existingScope !== undefined) {
      const existing = this.captures.get(existingScope)!;
      if (!isDeepStrictEqual(existing, candidate)) {
        throw new DebugChannelStoreError("capture_conflict");
      }
      return { kind: "existing", capture: clone(existing) };
    }
    const scopeKey = captureScopeKey(candidate);
    const existingByScope = this.captures.get(scopeKey);
    if (existingByScope !== undefined) {
      if (!isDeepStrictEqual(existingByScope, candidate)) {
        throw new DebugChannelStoreError("capture_conflict");
      }
      return { kind: "existing", capture: clone(existingByScope) };
    }
    this.captures.set(scopeKey, candidate);
    this.captureIdentities.set(identityKey, scopeKey);
    return { kind: "created", capture: clone(candidate) };
  }

  async getCapture(scope: DebugCaptureScope): Promise<DebugCapture | null> {
    return clone(this.captures.get(captureScopeKey(scope)) ?? null);
  }

  async listCaptures(query: ListDebugCaptures): Promise<DebugCapturePage> {
    assertListDebugCaptures(query);
    const items = [...this.captures.values()]
      .filter((capture) =>
        capture.tenant_id === query.tenant_id
        && capture.plugin_instance_id === query.plugin_instance_id
        && capture.conversation_id === query.conversation_id
        && (
          query.after_captured_at === undefined
          || capture.captured_at > query.after_captured_at
          || (
            capture.captured_at === query.after_captured_at
            && capture.capture_id > query.after_capture_id!
          )
        ))
      .sort((left, right) =>
        left.captured_at.localeCompare(right.captured_at)
        || left.capture_id.localeCompare(right.capture_id))
      .slice(0, query.limit)
      .map(clone);
    return { items };
  }

  async pruneExpired(input: PruneExpiredDebugRecords): Promise<{
    readonly submissions: number;
    readonly captures: number;
  }> {
    assertPruneExpiredDebugRecords(input);
    const captures = [...this.captures.values()]
      .filter((capture) =>
        capture.tenant_id === input.tenant_id
        && capture.plugin_instance_id === input.plugin_instance_id
        && capture.expires_at <= input.now)
      .sort((left, right) =>
        left.expires_at.localeCompare(right.expires_at)
        || left.capture_id.localeCompare(right.capture_id))
      .slice(0, input.limit);
    for (const capture of captures) {
      this.captures.delete(captureScopeKey(capture));
      this.captureIdentities.delete(captureIdentityKey(capture));
    }
    const remaining = input.limit - captures.length;
    const submissions = remaining === 0
      ? []
      : [...this.submissions.values()]
        .filter((submission) =>
          submission.tenant_id === input.tenant_id
          && submission.plugin_instance_id === input.plugin_instance_id
          && submission.expires_at <= input.now)
        .sort((left, right) =>
          left.expires_at.localeCompare(right.expires_at)
          || left.submission_id.localeCompare(right.submission_id))
        .slice(0, remaining);
    for (const submission of submissions) {
      this.submissions.delete(submissionScopeKey(submission));
      this.submissionIdentities.delete(submissionIdentityKey(submission));
    }
    return { submissions: submissions.length, captures: captures.length };
  }

  private async link(
    input: LinkDebugIngress | LinkDebugHandoff,
    field: "ingress_id" | "handoff_id",
    conflict: "ingress_conflict" | "handoff_conflict",
  ): Promise<DebugSubmission> {
    const scopeKey = submissionScopeKey(input);
    const current = this.submissions.get(scopeKey);
    if (current === undefined) {
      throw new DebugChannelStoreError("submission_not_found");
    }
    const value = field === "ingress_id"
      ? (input as LinkDebugIngress).ingress_id
      : (input as LinkDebugHandoff).handoff_id;
    if (current[field] !== undefined) {
      if (current[field] !== value) throw new DebugChannelStoreError(conflict);
      return clone(current);
    }
    const candidate = { ...current, [field]: value, updated_at: input.updated_at };
    assertDebugSubmission(candidate);
    this.submissions.set(scopeKey, candidate);
    return clone(candidate);
  }
}
