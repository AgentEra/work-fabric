import { describe, expect, it, vi } from "vitest";

import {
  AdmissionAdapterError,
  type AdmissionRequest,
} from "@work-fabric/admission-spi";
import type {
  FeishuContactApiClient,
  FeishuContactBatchResult,
} from "@work-fabric/connector-feishu";

import { FeishuDirectoryEvidenceProvider } from "../src/index.js";

const NOW = "2026-07-20T12:00:00.000Z";
const request: AdmissionRequest = {
  tenant_id: "tenant-a",
  connector_id: "connector-feishu-a",
  source_system: "feishu",
  external_tenant_id: "feishu-tenant-a",
  external_subject_type: "human",
  external_subject_id: "ou-user-a",
  ingress_id: "ingress-a",
  idempotency_key: "command-a",
};

class ContactClient implements FeishuContactApiClient {
  readonly calls: Array<{ readonly credential_ref: string; readonly user_ids: readonly string[] }> = [];

  constructor(private readonly result: FeishuContactBatchResult) {}

  async batchUsers(input: { readonly credential_ref: string; readonly user_ids: readonly string[] }): Promise<FeishuContactBatchResult> {
    this.calls.push(structuredClone(input));
    return this.result;
  }
}

function provider(result: FeishuContactBatchResult): {
  readonly client: ContactClient;
  readonly provider: FeishuDirectoryEvidenceProvider;
} {
  const client = new ContactClient(result);
  return {
    client,
    provider: new FeishuDirectoryEvidenceProvider({
      provider_ref: "feishu-directory-a",
      tenant_id: request.tenant_id,
      connector_id: request.connector_id,
      source_system: request.source_system,
      external_tenant_id: request.external_tenant_id,
      credential_ref: "credential-ref-a",
      client,
      clock: { now: () => NOW },
    }),
  };
}

function success(items: readonly unknown[]): FeishuContactBatchResult {
  return { kind: "accepted", items } as FeishuContactBatchResult;
}

function expectUnavailable(promise: Promise<unknown>): Promise<void> {
  return expect(promise).rejects.toSatisfy((error: unknown) =>
    error instanceof AdmissionAdapterError &&
    error.code === "evidence_unavailable" &&
    error.message === "feishu_directory_unavailable",
  );
}

describe("FeishuDirectoryEvidenceProvider", () => {
  it("returns bounded internal-active evidence for exactly one matching active user", async () => {
    const raw = {
      open_id: request.external_subject_id,
      name: "sensitive-name",
      mobile: "sensitive-mobile",
      email: "sensitive-email",
      avatar: { avatar_72: "sensitive-avatar" },
      status: { is_activated: true, is_exited: false, is_frozen: false },
    };
    const { client, provider: evidence } = provider(success([raw]));

    const result = await evidence.resolve(request);

    expect(result).toEqual({
      membership: "internal",
      active: true,
      observed_at: NOW,
      provider_revision: "feishu-contact-v3",
    });
    expect(client.calls).toEqual([{
      credential_ref: "credential-ref-a",
      user_ids: [request.external_subject_id],
    }]);
    expect(JSON.stringify(result)).not.toContain("sensitive-");
  });

  it.each([
    [{ is_activated: false, is_exited: false }],
    [{ is_activated: true, is_exited: true }],
  ])("returns internal-inactive evidence for an inactive or exited matching user", async (status) => {
    const evidence = provider(success([{
      open_id: request.external_subject_id,
      status,
    }])).provider;

    await expect(evidence.resolve(request)).resolves.toEqual({
      membership: "internal",
      active: false,
      observed_at: NOW,
      provider_revision: "feishu-contact-v3",
    });
  });

  it("keeps an absent visible directory item unknown rather than inferring external membership", async () => {
    const evidence = provider(success([])).provider;

    await expect(evidence.resolve(request)).resolves.toEqual({
      membership: "unknown",
      active: null,
      observed_at: NOW,
      provider_revision: "feishu-contact-v3",
    });
  });

  it("ignores nonmatching returned users", async () => {
    const evidence = provider(success([{
      open_id: "ou-another-user",
      status: { is_activated: true, is_exited: false },
    }])).provider;

    await expect(evidence.resolve(request)).resolves.toMatchObject({
      membership: "unknown",
      active: null,
    });
  });

  it.each([
    ["Feishu nonzero API code", { kind: "failure", error_code: "api_rejected" }],
    ["401/403 response", { kind: "failure", error_code: "http_rejected" }],
    ["429/5xx response", { kind: "failure", error_code: "temporarily_unavailable" }],
    ["request timeout", { kind: "failure", error_code: "request_timeout" }],
    ["oversized body", { kind: "failure", error_code: "response_too_large" }],
    ["malformed JSON", { kind: "failure", error_code: "invalid_response" }],
  ] as const)("maps %s to one sanitized evidence-unavailable error", async (_label, result) => {
    await expectUnavailable(provider(result).provider.resolve(request));
  });

  it("rejects malformed or ambiguous success bodies without exposing raw fields", async () => {
    const rawSecret = "raw-response-secret";
    const cases: FeishuContactBatchResult[] = [
      { kind: "accepted", items: "not-an-array" } as unknown as FeishuContactBatchResult,
      { kind: "accepted", items: [{
        open_id: request.external_subject_id,
        status: { is_activated: "yes", is_exited: false },
        rawSecret,
      }] } as unknown as FeishuContactBatchResult,
      success([
        { open_id: request.external_subject_id, status: { is_activated: true, is_exited: false } },
        { open_id: request.external_subject_id, status: { is_activated: true, is_exited: false } },
      ]),
    ];

    for (const result of cases) {
      let failure: unknown;
      try {
        await provider(result).provider.resolve(request);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(AdmissionAdapterError);
      expect(JSON.stringify(failure)).not.toContain(rawSecret);
      expect(String(failure)).not.toContain(rawSecret);
    }
  });

  it.each(["inherited", "accessor", "undefined_optional"] as const)("rejects an accepted client item with an %s field", async (kind) => {
    const item = kind === "inherited"
      ? Object.create({ open_id: request.external_subject_id }) as Record<string, unknown>
      : kind === "accessor"
        ? Object.defineProperty({}, "open_id", { get: () => request.external_subject_id }) as Record<string, unknown>
        : { open_id: request.external_subject_id };
    item.status = kind === "undefined_optional"
      ? { is_activated: true, is_exited: undefined }
      : { is_activated: true, is_exited: false };
    await expectUnavailable(provider({
      kind: "accepted",
      items: [item],
    } as unknown as FeishuContactBatchResult).provider.resolve(request));
  });

  it("treats absent is_exited as not exited", async () => {
    const evidence = provider(success([{
      open_id: request.external_subject_id,
      status: { is_activated: true },
    }])).provider;

    await expect(evidence.resolve(request)).resolves.toMatchObject({
      membership: "internal",
      active: true,
    });
  });

  it("fails closed on wrong external tenant scope before loading a token or calling Feishu", async () => {
    const fixture = provider(success([]));

    await expectUnavailable(fixture.provider.resolve({
      ...request,
      external_tenant_id: "feishu-tenant-b",
    }));
    expect(fixture.client.calls).toHaveLength(0);
  });

  it("exposes the required bounded, tenant-bound evidence capabilities", () => {
    const evidence = provider(success([])).provider;
    expect(evidence.provider_ref).toBe("feishu-directory-a");
    expect(evidence.manifest).toEqual({
      profile: "admission.evidence-provider.v1",
      adapter: "feishu-directory",
      capabilities: {
        authenticated_subject_facts: true,
        tenant_binding: true,
        bounded_evidence: true,
      },
    });
  });
});
