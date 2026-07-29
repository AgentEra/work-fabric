import type { ConnectorIngressStore } from "@work-fabric/connector-spi";
import type {
  DebugChannelStore,
  DebugSubmission,
} from "@work-fabric/debug-channel-spi";

export interface DebugHandoffSnapshot {
  readonly version: number;
  readonly lifecycle_state: string;
}

export interface DebugHandoffSnapshotSource {
  load(
    tenantId: string,
    handoffId: string,
  ): Promise<DebugHandoffSnapshot | null>;
}

export interface DebugSubmissionStatusSourceOptions {
  readonly tenant_id: string;
  readonly plugin_instance_id: string;
  readonly connector_id: string;
  readonly diagnostics: DebugChannelStore;
  readonly ingress: ConnectorIngressStore;
  readonly handoff_snapshots: DebugHandoffSnapshotSource;
}

export class DebugSubmissionStatusSource {
  constructor(private readonly options: DebugSubmissionStatusSourceOptions) {}

  async load(submissionId: string): Promise<Record<string, unknown> | null> {
    const submission = await this.options.diagnostics.getSubmission({
      tenant_id: this.options.tenant_id,
      plugin_instance_id: this.options.plugin_instance_id,
      submission_id: submissionId,
    });
    if (submission === null) return null;
    return this.status(submission);
  }

  private async status(
    submission: DebugSubmission,
  ): Promise<Record<string, unknown>> {
    const ingress = submission.ingress_id === undefined
      ? null
      : await this.options.ingress.get({
        tenant_id: this.options.tenant_id,
        connector_id: this.options.connector_id,
        ingress_id: submission.ingress_id,
      });
    const snapshot = submission.handoff_id === undefined
      ? null
      : await this.options.handoff_snapshots.load(
        this.options.tenant_id,
        submission.handoff_id,
      );
    return {
      submission_id: submission.submission_id,
      conversation_id: submission.conversation_id,
      created_at: submission.created_at,
      updated_at: submission.updated_at,
      ingress: ingress === null
        ? null
        : {
          ingress_id: ingress.ingress_id,
          state: ingress.state,
          attempt: ingress.attempt,
          updated_at: ingress.updated_at,
          ...(ingress.last_error_code === undefined
            ? {}
            : { error_code: ingress.last_error_code }),
        },
      handoff: submission.handoff_id === undefined
        ? null
        : {
          handoff_id: submission.handoff_id,
          ...(snapshot === null
            ? { state: "not_available" }
            : {
              version: snapshot.version,
              lifecycle_state: snapshot.lifecycle_state,
            }),
        },
    };
  }
}
