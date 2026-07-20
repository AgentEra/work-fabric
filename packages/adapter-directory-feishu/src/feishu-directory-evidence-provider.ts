import {
  ADMISSION_EVIDENCE_PROVIDER_REQUIRED_CAPABILITIES,
  AdmissionAdapterError,
  validateAdmissionRequest,
  type AdmissionRequest,
  type ExternalSubjectEvidence,
  type ExternalSubjectEvidenceProvider,
} from "@work-fabric/admission-spi";
import type { FeishuContactApiClient } from "@work-fabric/connector-feishu";
import { assertCapabilities, type CapabilityManifest } from "@work-fabric/exchange-spi";

const PROVIDER_REVISION = "feishu-contact-v3";

const manifest: CapabilityManifest = {
  profile: "admission.evidence-provider.v1",
  adapter: "feishu-directory",
  capabilities: {
    ...Object.fromEntries(ADMISSION_EVIDENCE_PROVIDER_REQUIRED_CAPABILITIES.map(
      (capability) => [capability, true],
    )),
  },
};

export interface FeishuDirectoryEvidenceProviderOptions {
  readonly provider_ref: string;
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly source_system: string;
  readonly external_tenant_id: string;
  readonly credential_ref: string;
  readonly client: FeishuContactApiClient;
  readonly clock: { now(): string };
}

function unavailable(): AdmissionAdapterError {
  return new AdmissionAdapterError(
    "evidence_unavailable",
    "feishu_directory_unavailable",
  );
}

function bounded(value: string, maximum = 255): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value
  ) {
    throw new TypeError("Feishu directory configuration is invalid");
  }
  return value;
}

function ownData(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw unavailable();
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) throw unavailable();
  return descriptor.value;
}

function observedAt(clock: { now(): string }): string {
  const value = clock.now();
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !Number.isFinite(Date.parse(value))
  ) throw unavailable();
  return value;
}

export class FeishuDirectoryEvidenceProvider
  implements ExternalSubjectEvidenceProvider {
  readonly provider_ref: string;
  private readonly scope: Readonly<{
    tenant_id: string;
    connector_id: string;
    source_system: string;
    external_tenant_id: string;
  }>;
  private readonly credentialRef: string;

  constructor(private readonly options: FeishuDirectoryEvidenceProviderOptions) {
    this.provider_ref = bounded(options.provider_ref);
    this.scope = Object.freeze({
      tenant_id: bounded(options.tenant_id),
      connector_id: bounded(options.connector_id),
      source_system: bounded(options.source_system),
      external_tenant_id: bounded(options.external_tenant_id),
    });
    this.credentialRef = bounded(options.credential_ref);
  }

  get manifest(): CapabilityManifest {
    const value = structuredClone(manifest);
    assertCapabilities(value, ADMISSION_EVIDENCE_PROVIDER_REQUIRED_CAPABILITIES);
    return value;
  }

  async resolve(request: AdmissionRequest): Promise<ExternalSubjectEvidence> {
    try {
      validateAdmissionRequest(request);
      if (
        request.tenant_id !== this.scope.tenant_id ||
        request.connector_id !== this.scope.connector_id ||
        request.source_system !== this.scope.source_system ||
        request.external_tenant_id !== this.scope.external_tenant_id ||
        request.external_subject_type !== "human"
      ) throw unavailable();

      const result = await this.options.client.batchUsers({
        credential_ref: this.credentialRef,
        user_ids: [request.external_subject_id],
      });
      if (ownData(result, "kind") !== "accepted") throw unavailable();
      const body = ownData(result, "body");
      if (ownData(body, "code") !== 0) throw unavailable();
      const data = ownData(body, "data");
      const items = ownData(data, "items");
      if (!Array.isArray(items)) throw unavailable();

      const matches = items.filter((item) => {
        try {
          return ownData(item, "open_id") === request.external_subject_id;
        } catch {
          return false;
        }
      });
      const timestamp = observedAt(this.options.clock);
      if (matches.length === 0) {
        return Object.freeze({
          membership: "unknown",
          active: null,
          observed_at: timestamp,
          provider_revision: PROVIDER_REVISION,
        });
      }
      if (matches.length !== 1) throw unavailable();
      const status = ownData(matches[0], "status");
      const activated = ownData(status, "is_activated");
      const exited = ownData(status, "is_exited");
      if (typeof activated !== "boolean" || typeof exited !== "boolean") {
        throw unavailable();
      }
      return Object.freeze({
        membership: "internal",
        active: activated === true && exited !== true,
        observed_at: timestamp,
        provider_revision: PROVIDER_REVISION,
      });
    } catch {
      throw unavailable();
    }
  }
}
