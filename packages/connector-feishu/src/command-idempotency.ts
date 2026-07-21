import { createHash } from "node:crypto";

import type { ConnectorIngressClaim } from "@work-fabric/connector-spi";

/** Derives the one command key that is bound into Admission and later executed. */
export function feishuCommandIdempotencyKey(claim: ConnectorIngressClaim): string {
  const digest = createHash("sha256")
    .update(claim.envelope.tenant_id)
    .update("\0")
    .update(claim.envelope.connector_id)
    .update("\0")
    .update(claim.envelope.dedupe_key)
    .digest("base64url");
  return `feishu:${digest}`;
}
