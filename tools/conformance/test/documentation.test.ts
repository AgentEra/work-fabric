import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  applyTransition,
  loadLifecycle,
  type HandoffState,
} from "../src/lifecycle-runner.js";
import {
  findJsonFiles,
  loadSchemaRegistry,
  type SchemaRegistryValidator,
} from "../src/schema-registry.js";

const protocolRoot = "protocol";

interface ReferenceMessage {
  readonly schema_id: string;
  readonly instance: unknown;
}

interface ReferenceStep {
  readonly interaction: string;
  readonly conditions: readonly string[];
  readonly expected_state: HandoffState;
  readonly expected_event_type: string;
}

interface ReferenceSequence {
  readonly name: string;
  readonly messages: readonly ReferenceMessage[];
  readonly lifecycle: readonly ReferenceStep[];
}

function validatorFor(
  getSchema: (id: string) => SchemaRegistryValidator | undefined,
  schemaId: string,
): SchemaRegistryValidator {
  const validator = getSchema(schemaId);
  if (validator === undefined) {
    throw new Error(`Schema not registered: ${schemaId}`);
  }
  return validator;
}

describe("protocol documentation", () => {
  it("indexes every public schema", async () => {
    const readme = await readFile(join(protocolRoot, "README.md"), "utf8");
    for (const file of await findJsonFiles(join(protocolRoot, "schemas", "v1"))) {
      const schema = JSON.parse(await readFile(file, "utf8")) as {
        $id?: string;
      };
      if (
        schema.$id !== undefined &&
        schema.$id !== "urn:work-fabric:schema:v1:definitions"
      ) {
        expect(readme, `missing schema index entry for ${schema.$id}`).toContain(
          `\`${schema.$id}\``,
        );
      }
    }
  });

  it("documents every authoritative lifecycle interaction", async () => {
    const lifecycle = await loadLifecycle(
      join(protocolRoot, "spec", "handoff-lifecycle.json"),
    );
    const interactions = await readFile(
      join(protocolRoot, "spec", "interactions.md"),
      "utf8",
    );

    for (const transition of lifecycle.transitions) {
      expect(
        interactions,
        `missing interaction documentation for ${transition.interaction}`,
      ).toContain(`\`${transition.interaction}\``);
    }
    expect(lifecycle.states).not.toContain("draft");
  });

  it("contains no unfinished normative markers", async () => {
    const files = [
      join(protocolRoot, "README.md"),
      ...(await findJsonFiles(join(protocolRoot, "examples"))),
      ...(await findJsonFiles(join(protocolRoot, "schemas", "v1"))),
      ...(await findJsonFiles(join(protocolRoot, "conformance"))),
      ...(await findJsonFiles(join(protocolRoot, "spec"))),
      ...[
        "core.md",
        "roles.md",
        "interactions.md",
        "events.md",
        "subscriptions.md",
        "security.md",
        "versioning.md",
      ].map((name) => join(protocolRoot, "spec", name)),
    ];

    for (const file of files) {
      const text = await readFile(file, "utf8");
      expect(text, `unfinished marker in ${file}`).not.toMatch(
        /\b(?:TBD|TODO|FIXME)\b/,
      );
    }
  });

  it.each([
    "human-to-agent",
    "agent-to-agent",
    "system-agent-system",
  ])("validates the %s reference sequence", async (exampleName) => {
    const registry = await loadSchemaRegistry(
      join(protocolRoot, "schemas", "v1"),
    );
    const lifecycle = await loadLifecycle(
      join(protocolRoot, "spec", "handoff-lifecycle.json"),
    );
    const sequence = JSON.parse(
      await readFile(
        join(protocolRoot, "examples", exampleName, "sequence.json"),
        "utf8",
      ),
    ) as ReferenceSequence;

    expect(sequence.name.length).toBeGreaterThan(0);
    expect(sequence.messages.length).toBeGreaterThan(0);
    for (const message of sequence.messages) {
      const validator = validatorFor(
        registry.getSchema.bind(registry),
        message.schema_id,
      );
      expect(
        validator(message.instance),
        JSON.stringify(validator.errors),
      ).toBe(true);
    }

    let state: HandoffState | null = null;
    for (const step of sequence.lifecycle) {
      const result = applyTransition(
        lifecycle,
        state,
        step.interaction,
        new Set(step.conditions),
      );
      expect(result.next_state).toBe(step.expected_state);
      expect(result.event_type).toBe(step.expected_event_type);
      state = result.next_state;
    }
  });
});
