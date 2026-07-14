import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  runFixtureDirectory,
  type FixtureResult,
} from "./fixture-runner.js";
import type {
  HandoffState,
  LifecycleModel,
  TransitionEffect,
} from "./lifecycle-runner.js";
import { applyTransition } from "./lifecycle-runner.js";
import { loadLifecycle } from "./lifecycle-runner.js";
import { findJsonFiles, loadSchemaRegistry } from "./schema-registry.js";

export interface LifecycleScenarioStep {
  readonly interaction: string;
  readonly conditions: readonly string[];
  readonly expected_state: HandoffState;
  readonly expected_event_type: string;
  readonly expected_effects?: readonly TransitionEffect[];
}

export interface LifecycleScenario {
  readonly name: string;
  readonly initial_state: HandoffState | null;
  readonly expected_valid: boolean;
  readonly expected_error?: string;
  readonly steps: readonly LifecycleScenarioStep[];
}

export interface LifecycleScenarioResult {
  readonly kind: "lifecycle_scenario";
  readonly name: string;
  readonly source: string;
  readonly passed: boolean;
  readonly final_state: HandoffState | null;
  readonly errors: readonly string[];
}

export interface ExchangeBehavior {
  readonly id: string;
  readonly description: string;
  readonly interactions: readonly string[];
  readonly assertions: readonly string[];
}

export interface ExchangeContract {
  readonly spec_version: "1.0";
  readonly profile: "exchange_core";
  readonly behaviors: readonly ExchangeBehavior[];
}

export interface ExchangeContractResult {
  readonly kind: "exchange_contract";
  readonly name: "Exchange Core golden behaviors";
  readonly source: string;
  readonly passed: boolean;
  readonly errors: readonly string[];
}

export interface SchemaCoverageResult {
  readonly kind: "schema_coverage";
  readonly name: "Public schema fixture coverage";
  readonly source: string;
  readonly passed: boolean;
  readonly errors: readonly string[];
}

export type RepositoryConformanceResult =
  | FixtureResult
  | LifecycleScenarioResult
  | ExchangeContractResult
  | SchemaCoverageResult;

export interface RepositoryConformanceReport {
  readonly results: readonly RepositoryConformanceResult[];
  readonly coverage: {
    readonly missing_positive: readonly string[];
    readonly missing_negative: readonly string[];
  };
  readonly exchange_behavior_count: number;
}

export const requiredExchangeBehaviorIds = [
  "identity_presentation",
  "endpoint_discovery",
  "handoff_offer",
  "handoff_accept",
  "handoff_decline",
  "handoff_expire",
  "handoff_cancel",
  "status_publish",
  "result_return",
  "result_verify",
  "rework",
  "transfer",
  "subscription_delivery_ack",
  "idempotent_retry_conflict",
] as const;

export function runLifecycleScenario(
  lifecycle: LifecycleModel,
  scenario: LifecycleScenario,
  source: string,
): LifecycleScenarioResult {
  let state = scenario.initial_state;
  const errors: string[] = [];

  try {
    for (const [index, step] of scenario.steps.entries()) {
      const result = applyTransition(
        lifecycle,
        state,
        step.interaction,
        new Set(step.conditions),
      );
      if (result.next_state !== step.expected_state) {
        errors.push(
          `Step ${index + 1} expected state ${step.expected_state}, received ${result.next_state}`,
        );
      }
      if (result.event_type !== step.expected_event_type) {
        errors.push(
          `Step ${index + 1} expected event ${step.expected_event_type}, received ${result.event_type}`,
        );
      }
      if (
        step.expected_effects !== undefined &&
        JSON.stringify(result.effects) !== JSON.stringify(step.expected_effects)
      ) {
        errors.push(`Step ${index + 1} effects did not match`);
      }
      state = result.next_state;
    }

    if (!scenario.expected_valid) {
      errors.push("Scenario expected an error but completed successfully");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (scenario.expected_valid) {
      errors.push(message);
    } else if (
      scenario.expected_error !== undefined &&
      !message.includes(scenario.expected_error)
    ) {
      errors.push(
        `Expected error containing '${scenario.expected_error}', received '${message}'`,
      );
    }
  }

  return {
    kind: "lifecycle_scenario",
    name: scenario.name,
    source,
    passed: errors.length === 0,
    final_state: state,
    errors,
  };
}

export function validateExchangeContract(
  contract: ExchangeContract,
  source: string,
): ExchangeContractResult {
  const errors: string[] = [];
  if (contract.spec_version !== "1.0") {
    errors.push("Exchange contract must use spec_version 1.0");
  }
  if (contract.profile !== "exchange_core") {
    errors.push("Exchange contract must use the exchange_core profile");
  }

  const identifiers = contract.behaviors.map((behavior) => behavior.id);
  const seen = new Set<string>();
  for (const identifier of identifiers) {
    if (seen.has(identifier)) {
      errors.push(`Duplicate Exchange behavior: ${identifier}`);
    }
    seen.add(identifier);
  }
  for (const identifier of requiredExchangeBehaviorIds) {
    if (!seen.has(identifier)) {
      errors.push(`Missing Exchange behavior: ${identifier}`);
    }
  }
  for (const behavior of contract.behaviors) {
    if (
      behavior.description.length === 0 ||
      behavior.interactions.length === 0 ||
      behavior.assertions.length === 0
    ) {
      errors.push(`Incomplete Exchange behavior: ${behavior.id}`);
    }
  }

  return {
    kind: "exchange_contract",
    name: "Exchange Core golden behaviors",
    source,
    passed: errors.length === 0,
    errors,
  };
}

async function loadLifecycleScenarios(
  lifecycle: LifecycleModel,
  root: string,
): Promise<LifecycleScenarioResult[]> {
  const results: LifecycleScenarioResult[] = [];
  for (const file of await findJsonFiles(root)) {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    const values = Array.isArray(parsed) ? parsed : [parsed];
    for (const [index, value] of values.entries()) {
      const source = values.length === 1 ? file : `${file}#${index + 1}`;
      results.push(
        runLifecycleScenario(lifecycle, value as LifecycleScenario, source),
      );
    }
  }
  return results;
}

async function publicSchemaIds(root: string): Promise<string[]> {
  const identifiers: string[] = [];
  for (const file of await findJsonFiles(root)) {
    const parsed = JSON.parse(await readFile(file, "utf8")) as {
      $id?: unknown;
    };
    if (
      typeof parsed.$id === "string" &&
      parsed.$id !== "urn:work-fabric:schema:v1:definitions"
    ) {
      identifiers.push(parsed.$id);
    }
  }
  return identifiers.sort((left, right) => left.localeCompare(right));
}

export async function runRepositoryConformance(
  repositoryRoot: string,
): Promise<RepositoryConformanceReport> {
  const protocolRoot = join(repositoryRoot, "protocol");
  const schemaRoot = join(protocolRoot, "schemas", "v1");
  const registry = await loadSchemaRegistry(schemaRoot);
  const positive = await runFixtureDirectory(
    registry,
    join(protocolRoot, "conformance", "fixtures", "positive"),
  );
  const negative = await runFixtureDirectory(
    registry,
    join(protocolRoot, "conformance", "fixtures", "negative"),
  );

  const publicIds = await publicSchemaIds(schemaRoot);
  const positiveIds = new Set(
    positive
      .filter((result) => result.expected_valid)
      .map((result) => result.schema_id),
  );
  const negativeIds = new Set(
    negative
      .filter((result) => !result.expected_valid)
      .map((result) => result.schema_id),
  );
  const missingPositive = publicIds.filter((id) => !positiveIds.has(id));
  const missingNegative = publicIds.filter((id) => !negativeIds.has(id));
  const coverageErrors = [
    ...missingPositive.map((id) => `Missing positive fixture: ${id}`),
    ...missingNegative.map((id) => `Missing negative fixture: ${id}`),
  ];
  const coverageResult: SchemaCoverageResult = {
    kind: "schema_coverage",
    name: "Public schema fixture coverage",
    source: schemaRoot,
    passed: coverageErrors.length === 0,
    errors: coverageErrors,
  };

  const lifecycle = await loadLifecycle(
    join(protocolRoot, "spec", "handoff-lifecycle.json"),
  );
  const scenarios = await loadLifecycleScenarios(
    lifecycle,
    join(protocolRoot, "conformance", "scenarios"),
  );

  const contractPath = join(
    protocolRoot,
    "conformance",
    "exchange-contract.json",
  );
  const contract = JSON.parse(
    await readFile(contractPath, "utf8"),
  ) as ExchangeContract;
  const contractResult = validateExchangeContract(contract, contractPath);

  return {
    results: [
      ...positive,
      ...negative,
      ...scenarios,
      contractResult,
      coverageResult,
    ],
    coverage: {
      missing_positive: missingPositive,
      missing_negative: missingNegative,
    },
    exchange_behavior_count: contract.behaviors.length,
  };
}
