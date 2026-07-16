import { describe, expect, it } from "vitest";

import {
  LocalAuthorityPolicy,
  LocalIdentityProvider,
} from "@work-fabric/adapter-identity-local";
import type { CollaborationQueryService } from "@work-fabric/operations-runtime";
import {
  BearerAuthenticationEvidenceMapper,
  createHttpService,
  normalizeHttpServiceConfig,
} from "../src/index.js";

const principal = {
  principal_id: "principal-1",
  tenant_id: "tenant-1",
  actor_claims: [
    {
      actor_id: "actor-1",
      actor_type: "agent" as const,
      endpoint_ids: ["endpoint-1"],
    },
  ],
  attributes: {},
};
const headers = {
  authorization: "Bearer known",
  "x-wf-actor-id": "actor-1",
  "x-wf-endpoint-id": "endpoint-1",
};
const page = {
  items: [],
  next_cursor: null,
  freshness: {
    projector_id: "workfabric.collaboration.visibility.v1",
    partition_id: "partition-1",
    projected_position: 4,
    journal_position: 5,
    observed_at: "2026-07-16T02:00:00.000Z",
  },
};

function fixture() {
  const calls: Array<{ method: string; tenant: string; input: unknown }> = [];
  const collaboration: CollaborationQueryService = {
    async listResponsibilities(tenant, input) {
      calls.push({ method: "responsibilities", tenant, input });
      return structuredClone(page);
    },
    async listTimeline(tenant, input) {
      calls.push({ method: "timeline", tenant, input });
      return structuredClone(page);
    },
    async listRelationships(tenant, input) {
      calls.push({ method: "relationships", tenant, input });
      return structuredClone(page);
    },
  };
  const actions = [
    "workfabric.query.responsibility.list.v1",
    "workfabric.query.timeline.list.v1",
    "workfabric.query.relationship.list.v1",
  ];
  const authority = new LocalAuthorityPolicy(
    actions.map((action) => ({
      tenant_id: "tenant-1",
      principal_id: "principal-1",
      actor_id: "actor-1",
      actor_type: "agent" as const,
      endpoint_id: "endpoint-1",
      action,
      resource_id: "partition-1",
    })),
  );
  const service = createHttpService(
    {
      application: { async handle() { throw new Error("not used"); } },
      authenticator: new BearerAuthenticationEvidenceMapper(),
      identity: new LocalIdentityProvider([
        { authentication_evidence: { bearer_token: "known" }, principal },
      ]),
      authority,
      collaboration,
    },
    normalizeHttpServiceConfig({ default_page_limit: 2, max_page_limit: 10 }),
  );
  return { service, calls };
}

describe("collaboration query routes", () => {
  it("uses the authenticated tenant and authorized partition for every view", async () => {
    const { service, calls } = fixture();
    const responsibilities = await service.dispatch({
      method: "GET",
      url: "/v1/responsibilities?partition_id=partition-1&responsible_actor_id=agent-1&lifecycle_state=accepted&priority=high&limit=3",
      headers,
    });
    const timeline = await service.dispatch({
      method: "GET",
      url: "/v1/timeline?partition_id=partition-1&handoff_id=handoff-1",
      headers,
    });
    const relationships = await service.dispatch({
      method: "GET",
      url: "/v1/relationships?partition_id=partition-1&thread_id=thread-1",
      headers,
    });

    expect([responsibilities.status_code, timeline.status_code, relationships.status_code]).toEqual([200, 200, 200]);
    expect(responsibilities.json()).toEqual(page);
    expect(calls).toEqual([
      {
        method: "responsibilities",
        tenant: "tenant-1",
        input: {
          partition_id: "partition-1",
          responsible_actor_id: "agent-1",
          lifecycle_states: ["accepted"],
          priorities: ["high"],
          limit: 3,
        },
      },
      {
        method: "timeline",
        tenant: "tenant-1",
        input: { partition_id: "partition-1", handoff_id: "handoff-1", limit: 2 },
      },
      {
        method: "relationships",
        tenant: "tenant-1",
        input: { partition_id: "partition-1", thread_id: "thread-1", limit: 2 },
      },
    ]);
    await service.close();
  });

  it("rejects missing partitions, invalid enums, and denied resources", async () => {
    const { service } = fixture();
    const missing = await service.dispatch({
      method: "GET",
      url: "/v1/responsibilities",
      headers,
    });
    const invalid = await service.dispatch({
      method: "GET",
      url: "/v1/responsibilities?partition_id=partition-1&lifecycle_state=made_up",
      headers,
    });
    const denied = await service.dispatch({
      method: "GET",
      url: "/v1/timeline?partition_id=partition-2",
      headers,
    });
    expect([missing.status_code, invalid.status_code, denied.status_code]).toEqual([400, 400, 403]);
    await service.close();
  });
});
