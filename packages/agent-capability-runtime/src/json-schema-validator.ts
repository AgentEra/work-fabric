import { createRequire } from "node:module";
import type { Ajv as AjvInstance, AnySchema, ValidateFunction } from "ajv";

import {
  canonicalCitizenDigest,
  type CitizenSchemaReference,
} from "@work-fabric/network-citizen-spi";
import type { RuntimeJsonObject } from "@work-fabric/agent-runtime-spi";

import type {
  BoundCapabilityContract,
  InvocationSchemaRegistry,
  InvocationSchemaValidator,
} from "./contracts.js";

const require = createRequire(import.meta.url);
const { default: Ajv } = require("ajv") as typeof import("ajv");

export class JsonSchemaInvocationValidator
  implements InvocationSchemaValidator {
  private readonly ajv: AjvInstance = new Ajv({
    allErrors: true,
    strict: true,
    validateFormats: false,
  });
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(private readonly registry: InvocationSchemaRegistry) {}

  async validateInput(
    contract: BoundCapabilityContract,
    input: RuntimeJsonObject,
    signal: AbortSignal,
  ): Promise<void> {
    if (contract.input_schema === undefined) return;
    const validator = await this.validator(contract.input_schema, signal);
    if (!validator(input)) {
      throw new TypeError("Capability input schema validation failed");
    }
  }

  async validateOutput(
    contract: BoundCapabilityContract,
    data: RuntimeJsonObject,
    artifacts: readonly RuntimeJsonObject[],
    signal: AbortSignal,
  ): Promise<{
    readonly data: RuntimeJsonObject;
    readonly artifacts: readonly RuntimeJsonObject[];
  }> {
    if (contract.output_schema !== undefined) {
      const validator = await this.validator(contract.output_schema, signal);
      if (!validator(data)) {
        throw new TypeError("Capability output schema validation failed");
      }
    }
    return {
      data: structuredClone(data),
      artifacts: structuredClone(artifacts),
    };
  }

  private async validator(
    reference: CitizenSchemaReference,
    signal: AbortSignal,
  ): Promise<ValidateFunction> {
    const key = `${reference.uri}\u0000${reference.digest}`;
    const cached = this.validators.get(key);
    if (cached !== undefined) return cached;
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    const schema = await this.registry.load(reference, signal);
    if (canonicalCitizenDigest(schema) !== reference.digest) {
      throw new TypeError("Capability schema digest does not match reference");
    }
    const compiled = this.ajv.compile(schema as AnySchema);
    this.validators.set(key, compiled);
    return compiled;
  }
}
