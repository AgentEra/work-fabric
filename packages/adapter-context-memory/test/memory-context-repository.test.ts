import { describe, expect, it } from "vitest";

import { verifyContextProfile } from "@work-fabric/exchange-conformance";
import type {
  ContextAccessRequest,
  ContextReference,
  JsonObject,
} from "@work-fabric/exchange-spi";

import { MemoryContextRepository } from "../src/index.js";

function contextBundle(overrides: JsonObject = {}): JsonObject {
  return {
    context_id: "context_01",
    version: 1,
    created_at: "2026-07-14T00:00:00.000Z",
    summary: "immutable shared context",
    items: [{ type: "text", text: "original" }],
    visibility_scope: {
      actor_ids: ["actor_01"],
      endpoint_ids: ["endpoint_01"],
      expires_at: null,
    },
    digest: "sha256:context-01-v1",
    extensions: {},
    ...overrides,
  };
}

function accessRequest(
  reference: ContextReference | null,
  overrides: Partial<ContextAccessRequest> = {},
): ContextAccessRequest {
  return {
    tenant_id: "tenant_01",
    actor_id: "actor_01",
    endpoint_id: "endpoint_01",
    reference,
    ...overrides,
  };
}

describe("MemoryContextRepository", () => {
  it("declares only the required context profile capabilities", () => {
    const repository = new MemoryContextRepository();

    expect(repository.manifest).toEqual({
      profile: "exchange.context.v1",
      adapter: "memory",
      capabilities: {
        immutable_versions: true,
        digest_verification: true,
        visibility_enforcement: true,
      },
    });
  });

  it("treats a missing optional Context reference as available", async () => {
    const repository = new MemoryContextRepository();

    await expect(repository.checkAvailability(accessRequest(null))).resolves.toEqual({
      kind: "available",
    });
  });

  it("returns a stable reference for an idempotent version and rejects a changed body", async () => {
    const repository = new MemoryContextRepository();
    const bundle = contextBundle();

    const first = await repository.putBundle("tenant_01", bundle);
    const replay = await repository.putBundle("tenant_01", structuredClone(bundle));

    expect(first).toEqual({
      context_id: "context_01",
      version: 1,
      digest: "sha256:context-01-v1",
    });
    expect(replay).toEqual(first);
    await expect(
      repository.putBundle(
        "tenant_01",
        contextBundle({ summary: "different body with the same digest" }),
      ),
    ).rejects.toThrow(/version|body|immutable|conflict/i);
    await expect(
      repository.putBundle(
        "tenant_01",
        contextBundle({ digest: "sha256:different" }),
      ),
    ).rejects.toThrow(/version|body|immutable|conflict/i);
  });

  it("reports a known visible version with a matching digest as available", async () => {
    const repository = new MemoryContextRepository();
    const reference = await repository.putBundle("tenant_01", contextBundle());

    await expect(
      repository.checkAvailability(accessRequest(reference)),
    ).resolves.toEqual({ kind: "available" });
  });

  it("reports unknown tenants, IDs, versions, and mismatched digests as unavailable", async () => {
    const repository = new MemoryContextRepository();
    const reference = await repository.putBundle("tenant_01", contextBundle());
    const requests: readonly ContextAccessRequest[] = [
      accessRequest(reference, { tenant_id: "tenant_02" }),
      accessRequest({ ...reference, context_id: "context_unknown" }),
      accessRequest({ ...reference, version: 2 }),
      accessRequest({ ...reference, digest: "sha256:mismatch" }),
    ];

    for (const request of requests) {
      await expect(repository.checkAvailability(request)).resolves.toMatchObject({
        kind: "unavailable",
      });
    }
  });

  it("requires every declared Actor and Endpoint audience constraint to match", async () => {
    const repository = new MemoryContextRepository();
    const reference = await repository.putBundle("tenant_01", contextBundle());
    const noAudienceReference = await repository.putBundle(
      "tenant_01",
      contextBundle({
        context_id: "context_no_audience",
        digest: "sha256:no-audience",
        visibility_scope: {
          actor_ids: [],
          endpoint_ids: [],
          expires_at: null,
        },
      }),
    );

    await expect(
      repository.checkAvailability(accessRequest(reference, { actor_id: "actor_hidden" })),
    ).resolves.toMatchObject({ kind: "unavailable" });
    await expect(
      repository.checkAvailability(
        accessRequest(reference, { endpoint_id: "endpoint_hidden" }),
      ),
    ).resolves.toMatchObject({ kind: "unavailable" });
    await expect(
      repository.checkAvailability(accessRequest(noAudienceReference)),
    ).resolves.toMatchObject({ kind: "unavailable" });
  });

  it("isolates stored Context and returned references from caller mutation", async () => {
    const repository = new MemoryContextRepository();
    const mutableBundle = structuredClone(contextBundle()) as {
      context_id: string;
      digest: string;
      visibility_scope: { actor_ids: string[]; endpoint_ids: string[] };
    };
    const firstReference = await repository.putBundle("tenant_01", mutableBundle);

    mutableBundle.context_id = "mutated-input";
    mutableBundle.digest = "sha256:mutated-input";
    mutableBundle.visibility_scope.actor_ids.length = 0;
    (firstReference as { context_id: string }).context_id = "mutated-output";

    await expect(
      repository.checkAvailability(
        accessRequest({
          context_id: "context_01",
          version: 1,
          digest: "sha256:context-01-v1",
        }),
      ),
    ).resolves.toEqual({ kind: "available" });
    await expect(
      repository.putBundle("tenant_01", contextBundle()),
    ).resolves.toEqual({
      context_id: "context_01",
      version: 1,
      digest: "sha256:context-01-v1",
    });
  });

  it("passes the reusable context profile verifier", async () => {
    const repository = new MemoryContextRepository();
    const reference: ContextReference = {
      context_id: "context_01",
      version: 1,
      digest: "sha256:context-01-v1",
    };

    await expect(
      verifyContextProfile(repository, {
        tenant_id: "tenant_01",
        bundle: contextBundle(),
        allowed_request: accessRequest(reference),
        denied_request: accessRequest(reference, { actor_id: "actor_hidden" }),
      }),
    ).resolves.toBeUndefined();
  });
});
