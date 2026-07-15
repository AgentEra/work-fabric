import { describe, expect, it } from "vitest";

import { verifySignalProfile } from "@work-fabric/exchange-conformance";
import type {
  ProtocolEvent,
  SignalDeliveryResult,
  SignalDestination,
} from "@work-fabric/exchange-spi";

import { InProcessSignalAdapter } from "../src/index.js";

function protocolEvent(id = "event_01"): ProtocolEvent {
  return {
    specversion: "1.0",
    id,
    source: "urn:work-fabric:exchange:exchange_01",
    type: "workfabric.handoff.offered.v1",
    subject: "handoff_01",
    time: "2026-07-14T00:00:00.000Z",
    datacontenttype: "application/json",
    dataschema: "urn:work-fabric:event:handoff-offered:v1",
    wftenant: "tenant_01",
    wfexchange: "exchange_01",
    wfthread: "thread_01",
    wfhandoff: "handoff_01",
    wfactor: "actor_01",
    wfendpoint: "endpoint_01",
    wfsequence: 1,
    wfvisibility: "participants",
    data: { state: "offered", nested: { value: "original" } },
  };
}

function destination(
  id = "destination_01",
  outcome?: SignalDeliveryResult["kind"],
  detail?: string,
): SignalDestination {
  return {
    destination_id: id,
    binding: "in-process",
    configuration: {
      channel: "test",
      nested: { value: "original" },
      ...(outcome === undefined ? {} : { outcome }),
      ...(detail === undefined ? {} : { detail }),
    },
  };
}

describe("InProcessSignalAdapter", () => {
  it("declares only the required signal profile capabilities", () => {
    const adapter = new InProcessSignalAdapter();

    expect(adapter.manifest).toEqual({
      profile: "exchange.signal.v1",
      adapter: "in-process",
      capabilities: {
        event_id_preservation: true,
        outcome_classification: true,
        payload_isolation: true,
      },
    });
  });

  it("performs one accepted delivery attempt while preserving Event ID and destination", async () => {
    const adapter = new InProcessSignalAdapter();
    const event = protocolEvent();
    const target = destination();

    await expect(adapter.deliver(event, target)).resolves.toEqual({
      kind: "accepted",
    });
    expect(adapter.deliveries()).toEqual([{ event, destination: target }]);
    expect(adapter.deliveries()[0]?.event.id).toBe("event_01");
    expect(adapter.deliveries()[0]?.destination.destination_id).toBe(
      "destination_01",
    );
  });

  it("returns configured retryable and permanent outcomes without retry orchestration", async () => {
    const adapter = new InProcessSignalAdapter();
    adapter.setOutcome("event_retryable", {
      kind: "retryable_failure",
      detail: "temporarily unavailable",
    });
    adapter.setOutcome("event_permanent", {
      kind: "permanent_failure",
      detail: "invalid destination",
    });

    await expect(
      adapter.deliver(protocolEvent("event_retryable"), destination("retryable")),
    ).resolves.toEqual({
      kind: "retryable_failure",
      detail: "temporarily unavailable",
    });
    await expect(
      adapter.deliver(protocolEvent("event_permanent"), destination("permanent")),
    ).resolves.toEqual({
      kind: "permanent_failure",
      detail: "invalid destination",
    });
    expect(adapter.deliveries()).toHaveLength(2);
  });

  it("passes the reusable signal profile verifier with Destination-configured outcomes", async () => {
    const adapter = new InProcessSignalAdapter();

    await expect(
      verifySignalProfile(adapter, {
        event: protocolEvent(),
        accepted_destination: destination("accepted", "accepted"),
        retryable_destination: destination(
          "retryable",
          "retryable_failure",
          "temporarily unavailable",
        ),
        permanent_destination: destination(
          "permanent",
          "permanent_failure",
          "invalid destination",
        ),
        observe_deliveries: async () => adapter.deliveries(),
      }),
    ).resolves.toBeUndefined();
  });

  it("keeps an Event-specific outcome ahead of Destination configuration", async () => {
    const adapter = new InProcessSignalAdapter();
    adapter.setOutcome("event_01", {
      kind: "permanent_failure",
      detail: "event-specific override",
    });

    await expect(
      adapter.deliver(
        protocolEvent(),
        destination("retryable", "retryable_failure", "Destination fallback"),
      ),
    ).resolves.toEqual({
      kind: "permanent_failure",
      detail: "event-specific override",
    });
  });

  it("isolates recorded payloads from both input and returned delivery mutation", async () => {
    const adapter = new InProcessSignalAdapter();
    const event = protocolEvent();
    const target = destination();

    await adapter.deliver(event, target);
    (event.data.nested as { value: string }).value = "mutated-input";
    (target.configuration.nested as { value: string }).value = "mutated-input";
    const returned = adapter.deliveries();
    (returned[0]?.event.data.nested as { value: string }).value = "mutated-output";
    (returned[0]?.destination.configuration.nested as { value: string }).value =
      "mutated-output";

    expect(adapter.deliveries()).toEqual([
      {
        event: protocolEvent(),
        destination: destination(),
      },
    ]);
  });
});
