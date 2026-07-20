import {
  ADMISSION_BINDING_STORE_REQUIRED_CAPABILITIES,
  type ParticipantBinding,
  type ParticipantBindingStore,
} from "@work-fabric/admission-spi";
import { assertCapabilities, type CapabilityManifest } from "@work-fabric/exchange-spi";

const manifest: CapabilityManifest = {
  profile: "admission.binding-store.v1",
  adapter: "memory",
  capabilities: {
    ...Object.fromEntries(ADMISSION_BINDING_STORE_REQUIRED_CAPABILITIES.map((capability) => [capability, true])),
    process_local_atomicity: true,
  },
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function key(parts: readonly string[]): string {
  return JSON.stringify(parts);
}

export class MemoryParticipantBindingStore implements ParticipantBindingStore {
  private readonly bindings = new Map<string, ParticipantBinding>();

  get manifest(): CapabilityManifest {
    const value = clone(manifest);
    assertCapabilities(value, ADMISSION_BINDING_STORE_REQUIRED_CAPABILITIES);
    return value;
  }

  async getOrCreate(input: Parameters<ParticipantBindingStore["getOrCreate"]>[0]): Promise<ParticipantBinding> {
    const candidate = clone(input);
    const bindingKey = key([
      candidate.request.tenant_id,
      candidate.request.connector_id,
      candidate.request.source_system,
      candidate.request.external_tenant_id,
      candidate.request.external_subject_type,
      candidate.external_subject_fingerprint,
    ]);
    let binding = this.bindings.get(bindingKey);
    if (binding === undefined) {
      binding = {
        tenant_id: candidate.request.tenant_id,
        connector_id: candidate.request.connector_id,
        source_system: candidate.request.source_system,
        external_tenant_id: candidate.request.external_tenant_id,
        external_subject_type: candidate.request.external_subject_type,
        external_subject_fingerprint: candidate.external_subject_fingerprint,
        actor_id: candidate.actor_id,
        actor_type: candidate.request.external_subject_type,
        endpoint_id: candidate.endpoint_id,
        created_at: candidate.created_at,
      };
      this.bindings.set(bindingKey, binding);
    }
    return clone(binding);
  }
}
