import { describe, expect, it } from "vitest";

import {
  ENDPOINT_AUTHORITY_ACTIONS,
  type CapabilityConstraintEvaluator,
  type EndpointDirectoryStore,
  type EndpointInboxStore,
} from "../src/index.js";

describe("Endpoint boundary ports", () => {
  it("publishes stable, non-overlapping authority actions", () => {
    expect(ENDPOINT_AUTHORITY_ACTIONS).toEqual([
      "workfabric.endpoint.provision.v1",
      "workfabric.endpoint.disable.v1",
      "workfabric.endpoint.session.open.v1",
      "workfabric.endpoint.session.heartbeat.v1",
      "workfabric.endpoint.session.close.v1",
      "workfabric.endpoint.read.v1",
      "workfabric.endpoint.identity.discover.v1",
      "workfabric.endpoint.capability-summary.discover.v1",
      "workfabric.endpoint.discover.v1",
      "workfabric.endpoint.capability.read.v1",
      "workfabric.endpoint.inbox.read.v1",
      "workfabric.endpoint.claim-pool.read.v1",
    ]);
    expect(new Set(ENDPOINT_AUTHORITY_ACTIONS).size).toBe(12);
  });

  it("keeps persistence and constraint contracts transport-neutral", () => {
    const compileOnly = <T>(_value: T): true => true;
    expect(compileOnly<EndpointDirectoryStore>).toBeTypeOf("function");
    expect(compileOnly<EndpointInboxStore>).toBeTypeOf("function");
    expect(compileOnly<CapabilityConstraintEvaluator>).toBeTypeOf("function");
  });
});
