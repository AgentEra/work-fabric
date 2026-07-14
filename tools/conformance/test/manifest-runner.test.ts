import { describe, expect, it } from "vitest";

import { loadLifecycle } from "../src/lifecycle-runner.js";
import {
  runRepositoryConformance,
  runLifecycleScenario,
  validateExchangeContract,
  type ExchangeContract,
  type LifecycleScenario,
} from "../src/manifest-runner.js";

describe("runLifecycleScenario", () => {
  it("executes scenario steps with the authoritative lifecycle runner", async () => {
    const lifecycle = await loadLifecycle(
      "protocol/spec/handoff-lifecycle.json",
    );
    const scenario: LifecycleScenario = {
      name: "offer and accept",
      initial_state: null,
      expected_valid: true,
      steps: [
        {
          interaction: "handoff.offer",
          conditions: [],
          expected_state: "offered",
          expected_event_type: "workfabric.handoff.offered.v1",
        },
        {
          interaction: "handoff.accept",
          conditions: ["recipient_authorized", "context_available"],
          expected_state: "accepted",
          expected_event_type: "workfabric.handoff.accepted.v1",
        },
      ],
    };

    expect(runLifecycleScenario(lifecycle, scenario, "happy.json")).toMatchObject(
      {
        name: "offer and accept",
        passed: true,
        final_state: "accepted",
      },
    );
  });

  it("passes an expected invalid-transition scenario", async () => {
    const lifecycle = await loadLifecycle(
      "protocol/spec/handoff-lifecycle.json",
    );
    const scenario: LifecycleScenario = {
      name: "cannot close returned result",
      initial_state: "result_returned",
      expected_valid: false,
      expected_error: "is not allowed from result_returned",
      steps: [
        {
          interaction: "handoff.close",
          conditions: ["verifier_authorized"],
          expected_state: "closed",
          expected_event_type: "workfabric.handoff.closed.v1",
        },
      ],
    };

    expect(runLifecycleScenario(lifecycle, scenario, "invalid.json").passed).toBe(
      true,
    );
  });
});

describe("validateExchangeContract", () => {
  it("rejects a contract that omits a required golden behavior", () => {
    const invalid: ExchangeContract = {
      spec_version: "1.0",
      profile: "exchange_core",
      behaviors: [],
    };

    const result = validateExchangeContract(invalid, "contract.json");

    expect(result.passed).toBe(false);
    expect(result.errors.join(" ")).toContain("identity_presentation");
  });
});

describe("runRepositoryConformance", () => {
  it("runs broad schema, lifecycle, and Exchange contract coverage", async () => {
    const result = await runRepositoryConformance(process.cwd());

    expect(result.results.length).toBeGreaterThan(60);
    expect(result.results.every((entry) => entry.passed)).toBe(true);
    expect(result.coverage.missing_positive).toEqual([]);
    expect(result.coverage.missing_negative).toEqual([]);
    expect(result.exchange_behavior_count).toBe(14);
  });
});
