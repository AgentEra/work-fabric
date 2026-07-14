import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import {
  runFixture,
  runFixtureDirectory,
  type ConformanceFixture,
} from "../src/fixture-runner.js";
import { loadSchemaRegistry } from "../src/schema-registry.js";

let registry: Awaited<ReturnType<typeof loadSchemaRegistry>>;

beforeAll(async () => {
  registry = await loadSchemaRegistry("protocol/schemas/v1");
});

describe("runFixture", () => {
  it("passes a valid positive fixture", () => {
    const fixture: ConformanceFixture = {
      name: "valid human actor",
      schema_id: "urn:work-fabric:schema:v1:actor-ref",
      expected_valid: true,
      instance: {
        actor_id: "actor_01",
        actor_type: "human",
      },
    };

    expect(runFixture(registry, fixture, "positive.json")).toMatchObject({
      name: "valid human actor",
      source: "positive.json",
      expected_valid: true,
      actual_valid: true,
      passed: true,
      errors: [],
    });
  });

  it("checks the expected keyword of a negative fixture", () => {
    const fixture: ConformanceFixture = {
      name: "actor type is required",
      schema_id: "urn:work-fabric:schema:v1:actor-ref",
      expected_valid: false,
      expected_keyword: "required",
      instance: { actor_id: "actor_01" },
    };

    expect(runFixture(registry, fixture, "negative.json").passed).toBe(true);
  });

  it("reports an unknown schema as an explicit failed case", () => {
    const result = runFixture(
      registry,
      {
        name: "unknown schema",
        schema_id: "urn:work-fabric:schema:v1:missing",
        expected_valid: true,
        instance: {},
      },
      "unknown.json",
    );

    expect(result.passed).toBe(false);
    expect(result.errors[0]?.message).toContain("Unknown schema");
  });
});

describe("runFixtureDirectory", () => {
  it("loads single and array fixture files in deterministic order", async () => {
    const root = await mkdtemp(join(tmpdir(), "wfpp-fixtures-"));
    await mkdir(join(root, "nested"));
    await writeFile(
      join(root, "z.json"),
      JSON.stringify({
        name: "z actor",
        schema_id: "urn:work-fabric:schema:v1:actor-ref",
        expected_valid: true,
        instance: { actor_id: "actor_z", actor_type: "agent" },
      }),
      "utf8",
    );
    await writeFile(
      join(root, "nested", "a.json"),
      JSON.stringify([
        {
          name: "a actor",
          schema_id: "urn:work-fabric:schema:v1:actor-ref",
          expected_valid: true,
          instance: { actor_id: "actor_a", actor_type: "human" },
        },
      ]),
      "utf8",
    );

    const results = await runFixtureDirectory(registry, root);

    expect(results.map((result) => result.name)).toEqual([
      "a actor",
      "z actor",
    ]);
    expect(results.every((result) => result.passed)).toBe(true);
  });
});
