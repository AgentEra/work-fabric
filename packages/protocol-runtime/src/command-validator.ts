import {
  loadWfppInteractionRegistry,
  type WfppInteractionRegistry,
} from "./interaction-registry.js";
import type {
  ValidationError,
  ValidationResult,
  WfppSchemaValidator,
} from "./schema-registry.js";

const COMMAND_ENVELOPE_SCHEMA_ID =
  "urn:work-fabric:schema:v1:command-envelope";
const INTERNAL_CHILD_ACCEPTED = "workfabric.handoff.child_accepted.v1";

export interface WfppCommandValidator {
  validate(envelope: unknown): ValidationResult;
  payloadSchemaId(messageType: string): string | null;
}

function unsupportedMessageType(messageType: string): ValidationResult {
  return {
    valid: false,
    errors: [
      {
        field: "/message_type",
        description: `unsupported_version: unsupported message_type ${messageType}`,
      },
    ],
  };
}

function payloadErrors(errors: readonly ValidationError[]): ValidationResult {
  return {
    valid: false,
    errors: errors.map((error) => ({
      field:
        error.field === "$schema"
          ? error.field
          : `/payload${error.field}`,
      description: error.description,
    })),
  };
}

function assertAllMappingsResolve(
  schemas: WfppSchemaValidator,
  registry: WfppInteractionRegistry,
): void {
  for (const schemaId of Object.values(registry.mappings)) {
    const probe = schemas.validate(schemaId, null);
    if (
      !probe.valid &&
      probe.errors.some(
        ({ field, description }) =>
          field === "$schema" && description === `Unknown schema: ${schemaId}`,
      )
    ) {
      throw new Error(`Interaction mapping references unknown Schema: ${schemaId}`);
    }
  }
}

export async function loadWfppCommandValidator(
  schemas: WfppSchemaValidator,
  interactionRegistryPath: string,
): Promise<WfppCommandValidator> {
  const registry = await loadWfppInteractionRegistry(interactionRegistryPath);
  assertAllMappingsResolve(schemas, registry);

  function payloadSchemaId(messageType: string): string | null {
    if (messageType === INTERNAL_CHILD_ACCEPTED) return null;
    return registry.mappings[messageType] ?? null;
  }

  return {
    payloadSchemaId,
    validate(envelope: unknown): ValidationResult {
      const envelopeResult = schemas.validate(
        COMMAND_ENVELOPE_SCHEMA_ID,
        envelope,
      );
      if (!envelopeResult.valid) return envelopeResult;

      const validatedEnvelope = envelope as {
        readonly message_type: string;
        readonly payload: unknown;
      };
      const schemaId = payloadSchemaId(validatedEnvelope.message_type);
      if (schemaId === null) {
        return unsupportedMessageType(validatedEnvelope.message_type);
      }

      const payloadResult = schemas.validate(schemaId, validatedEnvelope.payload);
      if (payloadResult.valid) return payloadResult;
      return payloadErrors(payloadResult.errors);
    },
  };
}
