import { createHmac } from "node:crypto";

import { GitHubProviderError } from "./errors.js";

const DOMAIN = "work-fabric/github/installation-identity/v1\0";

/**
 * Derives a deployment-local, non-reversible installation label. The cursor
 * secret may be used as key material, but the domain separator prevents a
 * label from being valid as a cursor MAC.
 */
export function githubInstallationIdentityLabel(
  installationId: string,
  deploymentKey: Uint8Array,
): `sha256:${string}` {
  if (
    typeof installationId !== "string" ||
    !/^\d+$/u.test(installationId) ||
    !(deploymentKey instanceof Uint8Array) ||
    deploymentKey.byteLength < 32
  ) {
    throw new GitHubProviderError("github_invalid_request");
  }
  return `sha256:${createHmac("sha256", deploymentKey)
    .update(DOMAIN, "utf8")
    .update(installationId, "utf8")
    .digest("hex")}`;
}
