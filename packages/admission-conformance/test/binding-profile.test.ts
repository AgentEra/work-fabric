import { expect, it } from "vitest";

import {
  ADMISSION_BINDING_STORE_REQUIRED_CAPABILITIES,
  type ParticipantBinding,
  type ParticipantBindingStore,
} from "@work-fabric/admission-spi";
import { runParticipantBindingStoreProfile } from "../src/index.js";

class OverwritingBindingStore implements ParticipantBindingStore {
  readonly manifest = {
    profile: "admission.binding-store.v1",
    adapter: "overwriting-test-double",
    capabilities: Object.fromEntries(
      ADMISSION_BINDING_STORE_REQUIRED_CAPABILITIES.map((capability) => [capability, true]),
    ),
  };
  private binding: ParticipantBinding | undefined;

  async getOrCreate(input: Parameters<ParticipantBindingStore["getOrCreate"]>[0]): Promise<ParticipantBinding> {
    const matchesExisting = this.binding !== undefined
      && this.binding.tenant_id === input.request.tenant_id
      && this.binding.connector_id === input.request.connector_id
      && this.binding.source_system === input.request.source_system
      && this.binding.external_tenant_id === input.request.external_tenant_id
      && this.binding.external_subject_type === input.request.external_subject_type
      && this.binding.external_subject_fingerprint === input.external_subject_fingerprint;
    if (matchesExisting) return structuredClone(this.binding!);
    this.binding = {
      tenant_id: input.request.tenant_id,
      connector_id: input.request.connector_id,
      source_system: input.request.source_system,
      external_tenant_id: input.request.external_tenant_id,
      external_subject_type: input.request.external_subject_type,
      external_subject_fingerprint: input.external_subject_fingerprint,
      actor_id: input.actor_id,
      actor_type: input.request.external_subject_type,
      endpoint_id: input.endpoint_id,
      created_at: input.created_at,
    };
    return structuredClone(this.binding);
  }
}

it("rejects a binding adapter that overwrites an existing tuple", async () => {
  await expect(runParticipantBindingStoreProfile(() => new OverwritingBindingStore())).rejects.toThrow();
});
