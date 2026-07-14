import type { ErrorObject } from "ajv";
import { beforeAll, describe, expect, it } from "vitest";

import { loadSchemaRegistry } from "../src/schema-registry.js";

let registry: Awaited<ReturnType<typeof loadSchemaRegistry>>;

beforeAll(async () => {
  registry = await loadSchemaRegistry("protocol/schemas/v1");
});

function errors(schemaName: string, value: unknown): ErrorObject[] | null {
  const schemaId = `urn:work-fabric:schema:v1:${schemaName}`;
  const validator = registry.getSchema(schemaId);
  if (validator === undefined) {
    throw new Error(`Schema not registered: ${schemaId}`);
  }
  validator(value);
  return validator.errors ?? null;
}

const acceptanceCriterion = {
  criterion_id: "tests-pass",
  description: "The repository test suite passes",
  required: true,
  result_schema_ref: null,
  required_evidence_types: ["test_report"],
  extensions: {},
};

const offer = {
  thread_id: "thread_01",
  work_reference: {
    uri: "urn:work:item:requirement-42",
    media_type: "application/vnd.work-item+json",
    version: "12",
    digest: null,
    extensions: {},
  },
  target: {
    endpoint_id: "endpoint_runtime_01",
  },
  intent: [
    {
      kind: "text",
      media_type: "text/plain",
      text: "Implement the approved change and return code and test evidence",
      language: "en",
    },
  ],
  context_bundle: {
    context_id: "context_01",
    version: 3,
    created_at: "2026-07-13T07:50:00Z",
    summary: "Approved requirement and implementation constraints",
    items: [],
    visibility_scope: {
      actor_ids: ["actor_agent_01"],
      endpoint_ids: ["endpoint_runtime_01"],
      expires_at: "2026-07-14T08:00:00Z",
    },
    digest: null,
    extensions: {},
  },
  authority_scope: {
    delegation_id: "dlg_01",
    scopes: ["work:read", "artifact:write"],
    resource_refs: ["urn:work:item:requirement-42"],
    expires_at: "2026-07-14T08:00:00Z",
    may_redelegate: false,
  },
  acceptance_criteria: [acceptanceCriterion],
  verifier: {
    actor_id: "actor_pm_01",
    actor_type: "human",
  },
  priority: "normal",
  accept_by: "2026-07-13T09:00:00Z",
  result_due_at: "2026-07-14T08:00:00Z",
  extensions: {},
};

function snapshot(context: {
  readonly context_bundle_id: string | null;
  readonly context_bundle_version: number | null;
}): unknown {
  return {
    handoff_id: "handoff_42",
    thread_id: "thread_01",
    resource_version: 1,
    lifecycle_state: "offered",
    current_responsible_actor: {
      actor_id: "actor_human_01",
      actor_type: "human",
    },
    package: {
      work_reference: offer.work_reference,
      target: offer.target,
      intent: offer.intent,
      ...context,
      authority_scope_id: "authority_01",
      acceptance_criteria_ids: ["tests-pass"],
      verifier_actor_id: "actor_pm_01",
      accept_by: "2026-07-13T09:00:00Z",
      result_due_at: "2026-07-14T08:00:00Z",
    },
    latest_status: null,
    result: null,
    parent_handoff_id: null,
    created_at: "2026-07-13T07:55:00Z",
    updated_at: "2026-07-13T08:00:00Z",
    extensions: {},
  };
}

const result = {
  summary: [
    {
      kind: "text",
      media_type: "text/plain",
      text: "Implemented the change and verified the test suite",
      language: "en",
    },
  ],
  artifacts: [
    {
      artifact_id: "artifact_commit_01",
      artifact_type: "source_commit",
      resource: {
        uri: "urn:git:repo:example:commit:abc123",
        media_type: "application/vnd.git.commit",
        version: "abc123",
        digest: null,
        extensions: {},
      },
      extensions: {},
    },
  ],
  evidence: [
    {
      evidence_id: "evidence_test_01",
      evidence_type: "test_report",
      content: {
        kind: "data",
        schema_ref: "urn:example:schema:test-report:v1",
        data: { passed: 42, failed: 0 },
      },
      extensions: {},
    },
  ],
  extensions: {},
};

describe("HandoffTarget", () => {
  it.each([
    { actor_id: "actor_agent_01" },
    { endpoint_id: "endpoint_runtime_01" },
    {
      capability_requirement: {
        capability_id: "software.implementation",
        version_constraint: ">=1.0.0 <2.0.0",
        input_media_types: ["text/markdown"],
        constraints: { region: "local" },
      },
    },
  ])("accepts exactly one target form", (target) => {
    expect(errors("handoff-target", target)).toBeNull();
  });

  it("rejects ambiguous targets", () => {
    expect(
      errors("handoff-target", {
        actor_id: "actor_agent_01",
        endpoint_id: "endpoint_runtime_01",
      }),
    ).not.toBeNull();
  });
});

describe("HandoffOffer", () => {
  it("accepts the approved external-execution package", () => {
    expect(errors("handoff-offer", offer)).toBeNull();
  });
});

describe("HandoffSnapshot", () => {
  it.each([
    "offered",
    "accepted",
    "result_returned",
    "verified",
    "rework_requested",
    "closed",
    "declined",
    "expired",
    "cancelled",
    "transferred",
  ])("accepts the %s lifecycle state", (lifecycleState) => {
    expect(
      errors("handoff-snapshot", {
        handoff_id: "handoff_42",
        thread_id: "thread_01",
        resource_version: 4,
        lifecycle_state: lifecycleState,
        current_responsible_actor: null,
        package: {
          work_reference: offer.work_reference,
          target: offer.target,
          intent: offer.intent,
          context_bundle_id: "context_01",
          context_bundle_version: 3,
          authority_scope_id: "authority_01",
          acceptance_criteria_ids: ["tests-pass"],
          verifier_actor_id: "actor_pm_01",
          accept_by: "2026-07-13T09:00:00Z",
          result_due_at: "2026-07-14T08:00:00Z",
        },
        latest_status: null,
        result: null,
        parent_handoff_id: null,
        created_at: "2026-07-13T07:55:00Z",
        updated_at: "2026-07-13T08:00:00Z",
        extensions: {},
      }),
    ).toBeNull();
  });

  it("rejects draft as a wire-visible lifecycle state", () => {
    expect(
      errors("handoff-snapshot", {
        handoff_id: "handoff_42",
        thread_id: "thread_01",
        resource_version: 1,
        lifecycle_state: "draft",
      }),
    ).not.toBeNull();
  });

  it("allows an absent Context only as a null ID/version pair", () => {
    const withoutContext = snapshot({
      context_bundle_id: null,
      context_bundle_version: null,
    });
    expect(errors("handoff-snapshot", withoutContext)).toBeNull();

    expect(
      errors(
        "handoff-snapshot",
        snapshot({
          context_bundle_id: "context_01",
          context_bundle_version: null,
        }),
      ),
    ).not.toBeNull();
    expect(
      errors(
        "handoff-snapshot",
        snapshot({ context_bundle_id: null, context_bundle_version: 1 }),
      ),
    ).not.toBeNull();
  });
});

describe("StatusUpdate", () => {
  it("models external execution status without lifecycle state", () => {
    expect(
      errors("status-update", {
        status_report_id: "status_01",
        execution_status: "in_progress",
        progress: 0.4,
        message: [],
        observed_at: "2026-07-13T08:30:00Z",
        next_update_at: "2026-07-13T09:00:00Z",
        blocked_on: [],
        extensions: {},
      }),
    ).toBeNull();
  });

  it.each([-0.1, 1.1])("rejects progress outside [0, 1]: %s", (progress) => {
    expect(
      errors("status-update", {
        status_report_id: "status_01",
        execution_status: "in_progress",
        progress,
        message: [],
        observed_at: "2026-07-13T08:30:00Z",
        blocked_on: [],
        extensions: {},
      }),
    ).not.toBeNull();
  });
});

describe("ResultSubmission", () => {
  it("accepts referenced artifacts and structured evidence", () => {
    expect(errors("result-submission", result)).toBeNull();
  });

  it("rejects inline binary artifacts", () => {
    const invalid = structuredClone(result);
    Object.assign(invalid.artifacts[0]!, {
      bytes: "AAEC",
    });

    expect(errors("result-submission", invalid)).not.toBeNull();
  });
});

describe("OperationReceipt", () => {
  it("accepts a canonical responsibility receipt", () => {
    expect(
      errors("operation-receipt", {
        receipt_id: "receipt_01",
        receipt_type: "responsibility_accepted",
        handoff_id: "handoff_42",
        actor_id: "actor_agent_01",
        endpoint_id: "endpoint_runtime_01",
        resource_version: 4,
        recorded_at: "2026-07-13T08:00:00Z",
        extensions: {},
      }),
    ).toBeNull();
  });
});
