import { createHmac } from "node:crypto";

import type {
  AdmissionRequest,
  ExternalSubjectFingerprinter,
} from "@work-fabric/admission-spi";

export class HmacSubjectFingerprinter implements ExternalSubjectFingerprinter {
  private readonly key: Uint8Array;

  constructor(key: Uint8Array) {
    if (!(key instanceof Uint8Array) || key.byteLength < 32) {
      throw new TypeError("Subject fingerprint key must contain at least 32 bytes");
    }
    this.key = Uint8Array.from(key);
  }

  fingerprint(request: AdmissionRequest): string {
    const input = JSON.stringify([
      "workfabric-admission-subject-v1",
      request.tenant_id,
      request.connector_id,
      request.source_system,
      request.external_tenant_id,
      request.external_subject_type,
      request.external_subject_id,
    ]);
    return `afp_${createHmac("sha256", this.key)
      .update(input, "utf8")
      .digest("base64url")}`;
  }
}
