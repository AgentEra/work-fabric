import { describe, expect, it } from "vitest";
import { canonicalCitizenDigest, type CapabilityExecutionContext } from "@work-fabric/network-citizen-spi";

import {
  GitHubCapabilityExecutor,
  GitHubProviderError,
  githubReadCapabilityDeclarations,
} from "../src/index.js";

const declaration = githubReadCapabilityDeclarations().find((item) =>
  item.declaration_id === "github.identity.get"
)!;
const digest = canonicalCitizenDigest(declaration);
const request = {
  invocation_id: "invocation-1",
  capability_id: declaration.declaration_id,
  capability_version: declaration.version,
  contract_digest: digest,
  input: {},
} as const;
const evidence = {
  original_handoff_id: "handoff-original",
  represented_actor_id: "actor-human",
  delegation_id: "delegation-github",
  delegation_scopes: ["github:read"],
  delegation_expires_at: "2026-08-02T10:01:00.000Z",
  capability_version: "1.0.0",
  contract_digest: digest,
} as const;
const context: CapabilityExecutionContext = {
  tenant_id: "tenant-a",
  citizen_id: "citizen-github",
  endpoint_id: "endpoint-github",
  fencing_token: 1,
  authority_evidence: evidence,
  signal: new AbortController().signal,
};

function executor(execute = async () => ({
  outcome: "succeeded" as const,
  data: { state: "complete", item: { app_id: "7" }, evidence: { provider: "github" } },
  artifacts: [],
})) {
  return new GitHubCapabilityExecutor({
    query_service: { execute },
    installation_id_hash: "sha256:installation",
    now: () => "2026-08-02T10:00:00.000Z",
  });
}

describe("GitHubCapabilityExecutor", () => {
  it("executes a declaration only when every Authority binding is current", async () => {
    await expect(executor().execute(request, context)).resolves.toMatchObject({
      outcome: "succeeded",
      data: { state: "complete" },
    });
  });

  it.each([
    ["original_handoff_id", ""],
    ["represented_actor_id", ""],
    ["delegation_id", ""],
    ["delegation_scopes", []],
    ["delegation_scopes", ["repository:read"]],
    ["delegation_expires_at", "2026-08-02T10:00:00.000Z"],
    ["delegation_expires_at", "invalid"],
    ["capability_version", "2.0.0"],
    ["contract_digest", "sha256:invalid"],
  ])("fails closed for invalid Authority field %s", async (field, value) => {
    let called = false;
    const result = await executor(async () => {
      called = true;
      throw new Error("must not execute");
    }).execute(request, {
      ...context,
      authority_evidence: { ...evidence, [field]: value },
    });

    expect(result).toEqual({
      outcome: "rejected",
      code: "github_forbidden",
      message: "github_forbidden",
      retryable: false,
    });
    expect(called).toBe(false);
  });

  it("rejects a request whose version or declaration digest differs from Authority", async () => {
    await expect(executor().execute({ ...request, capability_version: "2.0.0" }, context))
      .resolves.toMatchObject({ outcome: "rejected", code: "github_forbidden" });
    await expect(executor().execute({ ...request, contract_digest: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" }, context))
      .resolves.toMatchObject({ outcome: "rejected", code: "github_forbidden" });
  });

  it("maps provider diagnostics without leaking the upstream cause", async () => {
    const cause = { access_token: "secret", response: { data: "private" } };
    const result = await executor(async () => {
      const error = new GitHubProviderError("github_rate_limited", {
        retryable: false,
        retry_at: "2026-08-02T10:02:00.000Z",
        request_id: "request-1",
      });
      Object.defineProperty(error, "cause", { value: cause });
      throw error;
    }).execute(request, context);

    expect(result).toEqual({
      outcome: "failed",
      code: "github_rate_limited",
      message: "github_rate_limited",
      retryable: false,
      retry_after: "2026-08-02T10:02:00.000Z",
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|private|request-1/);
  });

  it("maps invalid requests to rejection and unexpected or aborted work to stable failure", async () => {
    await expect(executor(async () => {
      throw new GitHubProviderError("github_invalid_request");
    }).execute(request, context)).resolves.toEqual({
      outcome: "rejected",
      code: "github_invalid_request",
      message: "github_invalid_request",
      retryable: false,
    });

    await expect(executor(async () => {
      throw new Error("raw secret failure");
    }).execute(request, context)).resolves.toEqual({
      outcome: "failed",
      code: "github_upstream_unavailable",
      message: "github_upstream_unavailable",
      retryable: true,
    });
  });
});
