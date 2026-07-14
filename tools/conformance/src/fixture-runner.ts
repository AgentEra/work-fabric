import { readFile } from "node:fs/promises";

import {
  findJsonFiles,
  type SchemaRegistryError,
  type WfppSchemaRegistry,
} from "./schema-registry.js";

export interface ConformanceFixture {
  readonly name: string;
  readonly schema_id: string;
  readonly expected_valid: boolean;
  readonly expected_keyword?: string;
  readonly instance: unknown;
}

export interface NormalizedValidationError {
  readonly instance_path: string;
  readonly schema_path: string;
  readonly keyword: string;
  readonly message: string;
}

export interface FixtureResult {
  readonly kind: "schema_fixture";
  readonly name: string;
  readonly source: string;
  readonly schema_id: string;
  readonly expected_valid: boolean;
  readonly actual_valid: boolean;
  readonly passed: boolean;
  readonly errors: readonly NormalizedValidationError[];
}

function normalizeErrors(
  errors: readonly SchemaRegistryError[] | null | undefined,
): NormalizedValidationError[] {
  return (errors ?? [])
    .map((error) => ({
      instance_path: error.instancePath,
      schema_path: error.schemaPath,
      keyword: error.keyword,
      message: error.message ?? "validation failed",
    }))
    .sort((left, right) =>
      [left.instance_path, left.schema_path, left.keyword, left.message]
        .join("\u0000")
        .localeCompare(
          [right.instance_path, right.schema_path, right.keyword, right.message].join(
            "\u0000",
          ),
        ),
    );
}

function unknownSchemaError(schemaId: string): NormalizedValidationError {
  return {
    instance_path: "",
    schema_path: "",
    keyword: "schema_id",
    message: `Unknown schema: ${schemaId}`,
  };
}

export function runFixture(
  registry: WfppSchemaRegistry,
  fixture: ConformanceFixture,
  source: string,
): FixtureResult {
  const validator = registry.getSchema(fixture.schema_id);
  if (validator === undefined) {
    return {
      kind: "schema_fixture",
      name: fixture.name,
      source,
      schema_id: fixture.schema_id,
      expected_valid: fixture.expected_valid,
      actual_valid: false,
      passed: false,
      errors: [unknownSchemaError(fixture.schema_id)],
    };
  }

  const actualValid = validator(fixture.instance) === true;
  const errors = normalizeErrors(validator.errors);
  const keywordMatched =
    fixture.expected_keyword === undefined ||
    errors.some((error) => error.keyword === fixture.expected_keyword);

  return {
    kind: "schema_fixture",
    name: fixture.name,
    source,
    schema_id: fixture.schema_id,
    expected_valid: fixture.expected_valid,
    actual_valid: actualValid,
    passed: actualValid === fixture.expected_valid && keywordMatched,
    errors,
  };
}

function assertFixture(value: unknown, source: string): ConformanceFixture {
  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !("schema_id" in value) ||
    typeof value.schema_id !== "string" ||
    !("expected_valid" in value) ||
    typeof value.expected_valid !== "boolean" ||
    !("instance" in value)
  ) {
    throw new Error(`Invalid conformance fixture: ${source}`);
  }
  if (
    "expected_keyword" in value &&
    value.expected_keyword !== undefined &&
    typeof value.expected_keyword !== "string"
  ) {
    throw new Error(`Invalid expected_keyword in fixture: ${source}`);
  }
  return value as unknown as ConformanceFixture;
}

export async function runFixtureDirectory(
  registry: WfppSchemaRegistry,
  root: string,
): Promise<FixtureResult[]> {
  const results: FixtureResult[] = [];
  for (const file of await findJsonFiles(root)) {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    const values = Array.isArray(parsed) ? parsed : [parsed];
    for (const [index, value] of values.entries()) {
      const source = values.length === 1 ? file : `${file}#${index + 1}`;
      results.push(runFixture(registry, assertFixture(value, source), source));
    }
  }
  return results;
}
