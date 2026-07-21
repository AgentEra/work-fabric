import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type {
  AdmissionDecision,
  AdmissionRequest,
} from "@work-fabric/admission-spi";

import {
  HmacRepresentationGrants,
  type AdmissionGrantPayload,
} from "../src/index.js";

const NOW = "2026-07-20T00:00:00.000Z";
const OLD_KEY = new Uint8Array(32).fill(0x31);
const NEW_KEY = new Uint8Array(32).fill(0x32);

function request(overrides: Partial<AdmissionRequest> = {}): AdmissionRequest {
  return {
    tenant_id: "tenant-a",
    connector_id: "connector-a",
    source_system: "feishu",
    external_tenant_id: "external-tenant-a",
    external_subject_type: "human",
    external_subject_id: "raw-external-subject-AppSecret-42",
    ingress_id: "ingress-a",
    idempotency_key: "command-a",
    ...overrides,
  } as AdmissionRequest;
}

type AllowDecision = Extract<AdmissionDecision, { readonly kind: "allow" }>;

function decision(overrides: Partial<AllowDecision> = {}): AllowDecision {
  return {
    kind: "allow",
    reason_code: "explicit_allow",
    policy_id: "policy-a",
    policy_revision: "revision-a",
    decision_id: "decision-a",
    binding: {
      tenant_id: "tenant-a",
      connector_id: "connector-a",
      source_system: "feishu",
      external_tenant_id: "external-tenant-a",
      external_subject_type: "human",
      external_subject_fingerprint: "afp_private-fingerprint",
      actor_id: "actor-a",
      actor_type: "human",
      endpoint_id: "endpoint-a",
      created_at: NOW,
    },
    ...overrides,
  };
}

function grants(options: {
  readonly active_key_id?: string;
  readonly keys?: Readonly<Record<string, Uint8Array>>;
  readonly now?: string;
  readonly grantId?: () => string;
} = {}): HmacRepresentationGrants {
  return new HmacRepresentationGrants({
    active_key_id: options.active_key_id ?? "new",
    keys: options.keys ?? { old: OLD_KEY, new: NEW_KEY },
    clock: { now: () => options.now ?? NOW },
    ids: { grantId: options.grantId ?? (() => "grant-a") },
  });
}

function decodePayload(grant: string): { readonly json: string; readonly payload: AdmissionGrantPayload } {
  const encoded = grant.split(".")[0]!;
  const json = Buffer.from(encoded, "base64url").toString("utf8");
  return { json, payload: JSON.parse(json) as AdmissionGrantPayload };
}

function signedToken(payload: unknown, key: Uint8Array = NEW_KEY, json = JSON.stringify(payload)): string {
  const bytes = Buffer.from(json, "utf8");
  return `${bytes.toString("base64url")}.${createHmac("sha256", key).update(bytes).digest("base64url")}`;
}

function validPayload(overrides: Partial<AdmissionGrantPayload> = {}): AdmissionGrantPayload {
  return {
    v: 2,
    kid: "new",
    grant_id: "grant-a",
    tenant_id: "tenant-a",
    connector_id: "connector-a",
    ingress_id: "ingress-a",
    idempotency_key: "command-a",
    decision_id: "decision-a",
    actor_id: "actor-a",
    actor_type: "human",
    endpoint_id: "endpoint-a",
    external_subject_fingerprint: "afp_private-fingerprint",
    issued_at: NOW,
    expires_at: "2026-07-20T00:05:00.000Z",
    ...overrides,
  };
}

describe("HmacRepresentationGrants issuance", () => {
  it("issues deterministic flat JSON in the documented order without raw identity or App credentials", async () => {
    const grantId = vi.fn(() => "grant-a");
    const grant = await grants({ grantId }).issue({
      request: request(),
      decision: decision(),
      expires_at: "2026-07-20T00:05:00.000Z",
    });
    const decoded = decodePayload(grant);

    expect(grantId).toHaveBeenCalledOnce();
    expect(decoded.json).toBe(JSON.stringify(validPayload()));
    expect(Object.keys(decoded.payload)).toEqual([
      "v", "kid", "grant_id", "tenant_id", "connector_id", "ingress_id",
      "idempotency_key",
      "decision_id", "actor_id", "actor_type", "endpoint_id",
      "external_subject_fingerprint", "issued_at", "expires_at",
    ]);
    expect(grant).not.toContain("raw-external-subject");
    expect(decoded.json).not.toContain("raw-external-subject");
    expect(decoded.json).not.toContain("AppSecret");
    expect(decoded.json).not.toContain(Buffer.from(NEW_KEY).toString("hex"));
    expect(grant.split(".")[1]).toBe(
      createHmac("sha256", NEW_KEY).update(Buffer.from(decoded.json, "utf8")).digest("base64url"),
    );
  });

  it("uses only the binding fingerprint and rejects inconsistent binding scope or subject type", async () => {
    const input = { request: request(), decision: decision(), expires_at: "2026-07-20T00:01:00.000Z" };
    await expect(grants().issue(input)).resolves.toEqual(expect.any(String));

    for (const [field, value] of [
      ["tenant_id", "tenant-b"],
      ["connector_id", "connector-b"],
      ["source_system", "slack"],
      ["external_tenant_id", "external-tenant-b"],
      ["external_subject_type", "agent"],
      ["actor_type", "agent"],
    ] as const) {
      await expect(grants().issue({
        ...input,
        decision: decision({ binding: { ...decision().binding, [field]: value } }),
      })).rejects.toThrow(TypeError);
    }

    const token = await grants().issue({
      ...input,
      request: { ...input.request, external_subject_fingerprint: "request-controlled" } as AdmissionRequest,
    });
    expect(decodePayload(token).payload.external_subject_fingerprint).toBe("afp_private-fingerprint");
  });

  it("enforces strict timestamps and the same positive 300-second lifetime bound", async () => {
    const issuer = grants();
    await expect(issuer.issue({ request: request(), decision: decision(), expires_at: NOW })).rejects.toThrow(TypeError);
    await expect(issuer.issue({ request: request(), decision: decision(), expires_at: "2026-07-20T00:05:00.001Z" })).rejects.toThrow(TypeError);
    await expect(issuer.issue({ request: request(), decision: decision(), expires_at: "2026-02-30T00:01:00Z" })).rejects.toThrow(TypeError);
    await expect(issuer.issue({ request: request(), decision: decision(), expires_at: "2026-07-20T00:05:00.000Z" })).resolves.toEqual(expect.any(String));
    await expect(grants({ now: "not-a-timestamp" }).issue({ request: request(), decision: decision(), expires_at: "2026-07-20T00:01:00Z" })).rejects.toThrow(TypeError);
  });

  it("clones all keys and requires the active kid to be an own configured key", async () => {
    const mutableOld = new Uint8Array(32).fill(3);
    const mutableNew = new Uint8Array(32).fill(4);
    const codec = grants({ keys: { old: mutableOld, new: mutableNew } });
    const newToken = await codec.issue({ request: request(), decision: decision(), expires_at: "2026-07-20T00:01:00Z" });
    const oldToken = signedToken(validPayload({ kid: "old", expires_at: "2026-07-20T00:01:00Z" }), mutableOld);
    mutableOld.fill(8);
    mutableNew.fill(9);
    await expect(codec.verify(newToken, NOW)).resolves.toEqual(expect.objectContaining({ decision_id: "decision-a" }));
    await expect(codec.verify(oldToken, NOW)).resolves.toEqual(expect.objectContaining({ decision_id: "decision-a" }));

    expect(() => grants({ keys: { new: new Uint8Array(31) } })).toThrow(TypeError);
    expect(() => grants({ active_key_id: "missing", keys: { new: NEW_KEY } })).toThrow(TypeError);
    const inherited = Object.create({ inherited: NEW_KEY }) as Record<string, Uint8Array>;
    inherited.new = NEW_KEY;
    expect(() => grants({ active_key_id: "inherited", keys: inherited })).toThrow(TypeError);
  });
});

describe("HmacRepresentationGrants verification", () => {
  it("rejects legacy v1 grants and returns the bound command idempotency key for v2", async () => {
    const codec = grants();
    const token = await codec.issue({
      request: request(),
      decision: decision(),
      expires_at: "2026-07-20T00:01:00.000Z",
    });
    await expect(codec.verify(token, NOW)).resolves.toEqual(expect.objectContaining({
      ingress_id: "ingress-a",
      idempotency_key: "command-a",
    }));

    const { idempotency_key: _removed, ...legacyPayload } = validPayload() as AdmissionGrantPayload & { readonly idempotency_key: string };
    const legacy = signedToken({ ...legacyPayload, v: 1 });
    await expect(codec.verify(legacy, NOW)).resolves.toBeNull();
  });
  it("verifies connector and ingress-bound grants across an overlapping rotation window", async () => {
    const oldIssuer = grants({ active_key_id: "old" });
    const oldToken = await oldIssuer.issue({ request: request(), decision: decision(), expires_at: "2026-07-20T00:01:00Z" });
    const rotating = grants({ active_key_id: "new" });

    await expect(rotating.verify(oldToken, NOW)).resolves.toEqual({
      tenant_id: "tenant-a",
      connector_id: "connector-a",
      ingress_id: "ingress-a",
      idempotency_key: "command-a",
      decision_id: "decision-a",
      actor_id: "actor-a",
      actor_type: "human",
      endpoint_id: "endpoint-a",
      external_subject_fingerprint: "afp_private-fingerprint",
      expires_at: "2026-07-20T00:01:00Z",
    });
    await expect(grants({ keys: { new: NEW_KEY } }).verify(oldToken, NOW)).resolves.toBeNull();
  });

  it("returns null for tamper, unknown kid, and invalid signatures", async () => {
    const codec = grants();
    const token = await codec.issue({ request: request(), decision: decision(), expires_at: "2026-07-20T00:01:00Z" });
    const [payload, signature] = token.split(".") as [string, string];
    const changed = `${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}`;

    await expect(codec.verify(`${changed}.${signature}`, NOW)).resolves.toBeNull();
    await expect(codec.verify(`${payload}.${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`, NOW)).resolves.toBeNull();
    await expect(codec.verify(signedToken(validPayload({ kid: "unknown" })), NOW)).resolves.toBeNull();
    await expect(codec.verify(signedToken(validPayload(), OLD_KEY), NOW)).resolves.toBeNull();
  });

  it("treats every malformed or oversized untrusted token as null", async () => {
    const codec = grants();
    for (const token of [
      "", ".", "a.", ".b", "a.b.c", "not+base64.signature", "payload.not+base64",
      "a".repeat(16_385), "e30.YQ", signedToken("not-an-object"), signedToken({}),
    ]) {
      await expect(codec.verify(token, NOW)).resolves.toBeNull();
    }
    await expect(codec.verify(signedToken(validPayload()), "invalid-now")).resolves.toBeNull();
  });

  it("requires exact payload keys, types, actor type, and bounded identifiers", async () => {
    const codec = grants();
    const invalidPayloads: unknown[] = [
      { ...validPayload(), extra: true },
      Object.fromEntries(Object.entries(validPayload()).filter(([key]) => key !== "grant_id")),
      { ...validPayload(), v: 1 },
      Object.fromEntries(Object.entries(validPayload()).filter(([key]) => key !== "idempotency_key")),
      { ...validPayload(), idempotency_key: "x".repeat(257) },
      { ...validPayload(), actor_type: "robot" },
      { ...validPayload(), connector_id: "" },
      { ...validPayload(), actor_id: "a".repeat(129) },
      { ...validPayload(), tenant_id: " tenant-a" },
      { ...validPayload(), external_subject_fingerprint: 42 },
    ];
    for (const payload of invalidPayloads) {
      await expect(codec.verify(signedToken(payload), NOW)).resolves.toBeNull();
    }
  });

  it("validates real UTC instants, strict expiry, future-issued, and lifetime boundaries", async () => {
    const codec = grants();
    const validCases = [
      validPayload({ expires_at: "2026-07-20T00:00:00.000000001Z" }),
      validPayload({ issued_at: "2026-07-20T00:00:30.000Z", expires_at: "2026-07-20T00:01:00.000Z" }),
      validPayload({ issued_at: "2026-07-19T23:55:00.000Z", expires_at: NOW }),
    ];
    for (const payload of validCases) {
      const now = payload.expires_at === NOW ? "2026-07-19T23:59:59.999999999Z" : NOW;
      await expect(codec.verify(signedToken(payload), now)).resolves.toEqual(expect.objectContaining({ actor_id: "actor-a" }));
    }

    const invalidCases = [
      validPayload({ expires_at: NOW }),
      validPayload({ issued_at: "2026-07-20T00:00:30.000000001Z", expires_at: "2026-07-20T00:01:00Z" }),
      validPayload({ issued_at: NOW, expires_at: "2026-07-20T00:05:00.000000001Z" }),
      validPayload({ issued_at: NOW, expires_at: NOW }),
      validPayload({ issued_at: "2026-07-20T00:00:01Z", expires_at: NOW }),
      validPayload({ issued_at: "2026-02-30T00:00:00Z" }),
      validPayload({ expires_at: "2026-07-20T00:05:00+00:00" }),
    ];
    for (const payload of invalidCases) {
      await expect(codec.verify(signedToken(payload), NOW)).resolves.toBeNull();
    }
  });

  it.each([
    ["pretty whitespace", (payload: AdmissionGrantPayload) => JSON.stringify(payload, null, 1)],
    ["reordered fields", (payload: AdmissionGrantPayload) => JSON.stringify({
      kid: payload.kid,
      v: payload.v,
      grant_id: payload.grant_id,
      tenant_id: payload.tenant_id,
      connector_id: payload.connector_id,
      ingress_id: payload.ingress_id,
      idempotency_key: payload.idempotency_key,
      decision_id: payload.decision_id,
      actor_id: payload.actor_id,
      actor_type: payload.actor_type,
      endpoint_id: payload.endpoint_id,
      external_subject_fingerprint: payload.external_subject_fingerprint,
      issued_at: payload.issued_at,
      expires_at: payload.expires_at,
    })],
    ["a duplicate kid", (payload: AdmissionGrantPayload) => JSON.stringify(payload).replace(
      '"kid":"new"',
      '"kid":"old","kid":"new"',
    )],
    ["alternate numeric v spelling", (payload: AdmissionGrantPayload) => JSON.stringify(payload).replace(
      '"v":2',
      '"v":2e0',
    )],
  ])("rejects an authenticated payload encoded with %s", async (_scenario, encode) => {
    const payload = validPayload({ expires_at: "2026-07-20T00:01:00Z" });
    await expect(grants().verify(signedToken(payload, NEW_KEY, encode(payload)), NOW)).resolves.toBeNull();
  });
});
