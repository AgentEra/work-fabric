# Collaboration Admission Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a source-neutral, default-deny Collaboration Admission Layer that admits verified external participants into Work Fabric with stable Actor/Endpoint bindings while preserving the public SDK, Identity, Authority and Exchange Core command path.

**Architecture:** A connector first durably accepts an authenticated external event, then calls `CollaborationAdmissionService` with source and subject facts. The service loads one immutable tenant-scoped policy, evaluates fixed precedence, obtains directory evidence only for verified internal-member rules, creates an idempotent participant binding, records a bounded decision and issues a short-lived ingress-bound representation grant. Channel adapters translate decisions into explicit connector commands; the SDK presents the grant, an admission Identity adapter resolves exactly one Actor claim, and a separate Authority adapter allows only the configured Intake operation.

**Tech Stack:** Node.js `>=22.20.0`, TypeScript `7.0.2`, ES modules, npm workspaces, Vitest `4.1.10`, Node `crypto`, Node `sqlite`, PostgreSQL through `@work-fabric/adapter-postgres-common`, existing global Configuration/Plugin/Connector/HTTP/SDK runtimes.

## Global Constraints

- Work Fabric owns collaboration admission, stable identity binding, handoff and visibility mechanics; it does not own business approval, content moderation, Agent reasoning, target selection, workflow automation or participant execution.
- Admission runs after transport authentication and durable Connector ingress acceptance, and before connector command execution.
- Every connector command continues through the public TypeScript SDK, HTTP authentication, `IdentityProvider`, `AuthorityPolicy` and Exchange Core.
- Deny precedence is fixed: exact deny, exact allow, verified active internal human, default deny; it is not configurable.
- `all_internal_members` applies only to `human` subjects with fresh `internal` and `active === true` evidence. A bare `"*"` subject identifier is invalid.
- Agent and system subjects require exact allow entries.
- Directory or persistence outages fail closed and return a retryable outcome; they never become allow or permanent deny.
- One external subject maps to one stable Actor and Endpoint per Work Fabric tenant, connector, source system, external tenant and subject type.
- Decisions, logs and telemetry never contain App Secrets, access tokens, raw grants, message content, raw directory responses or raw external subject identifiers.
- YAML is the first configuration source, not part of Admission contracts; future database and remote Providers implement the same SPI.
- Memory adapters are demo/test only; SQLite is single-process local persistence; PostgreSQL is the cluster-safe production authority.
- Each task is test-first and ends with focused tests, typecheck, relevant boundary checks and one intentional commit.

## File Structure

New packages are split by responsibility:

- `packages/admission-spi`: source-neutral policies, requests, evidence, binding, decision, grant and service contracts.
- `packages/admission-runtime`: policy compilation, deterministic evaluation, evidence caching and orchestration.
- `packages/admission-conformance`: reusable binding/decision adapter profiles.
- `packages/adapter-admission-configuration`: converts one immutable global configuration snapshot into Admission policy documents.
- `packages/adapter-admission-memory`: demo binding and decision stores.
- `packages/adapter-admission-sqlite`: local durable binding and decision stores.
- `packages/adapter-admission-postgres`: cluster-safe binding and decision stores.
- `packages/adapter-directory-feishu`: Feishu Contact API evidence provider; it contains Feishu semantics but no policy.
- `packages/adapter-identity-admission`: keyed subject fingerprints, representation grant issue/verification and dynamic Identity resolution.
- `packages/adapter-authority-admission`: narrowly authorizes admission-backed connector principals for explicit Intake operations.

Existing packages change only at their owned seams:

- `configuration-runtime` carries validated named root sections in an immutable snapshot.
- `connector-spi` carries a command-scoped opaque bearer credential and a required Actor type, never an Admission policy.
- `sdk-typescript` supports command-scoped authentication without bypassing transport.
- `connector-feishu` translates a normalized Feishu participant into a source-neutral Admission request.
- `plugin-channel-feishu` selects a global policy and evidence provider; it owns no precedence rule.
- `service-node` is the only composition root.

---

### Task 1: Define the source-neutral Admission SPI

**Files:**

- Create: `packages/admission-spi/package.json`
- Create: `packages/admission-spi/src/index.ts`
- Create: `packages/admission-spi/src/contracts.ts`
- Create: `packages/admission-spi/src/errors.ts`
- Create: `packages/admission-spi/test/contracts.test.ts`

**Interfaces:**

- Consumes: `ExchangeAdapter`, `CapabilityManifest` and `JsonObject` from `@work-fabric/exchange-spi`.
- Produces: `AdmissionRequest`, `AdmissionPolicy`, `ExternalSubjectEvidence`, `ParticipantBinding`, `AdmissionDecision`, Provider/store/grant ports and `CollaborationAdmissionService`.

- [ ] **Step 1: Create the workspace manifest and failing contract tests**

Use this manifest:

```json
{
  "name": "@work-fabric/admission-spi",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "types": "./src/index.ts",
  "dependencies": { "@work-fabric/exchange-spi": "0.1.0" }
}
```

Write `contracts.test.ts` to construct every union member, assert `ADMISSION_*_REQUIRED_CAPABILITIES`, reject blank/oversized identifiers through `validateAdmissionRequest`, and verify that `AdmissionAdapterError` exposes only these stable codes:

```ts
"policy_unavailable" | "evidence_unavailable" | "binding_store_unavailable" |
"decision_store_unavailable" | "grant_unavailable"
```

- [ ] **Step 2: Run the contract test and confirm RED**

Run:

```bash
npx vitest run packages/admission-spi/test/contracts.test.ts
```

Expected: FAIL because `@work-fabric/admission-spi` and its exported contracts do not exist.

- [ ] **Step 3: Implement the exact public contract**

Define these bounded source-neutral types in `contracts.ts`:

```ts
export type AdmissionSubjectType = "human" | "agent" | "system";

export interface AdmissionScope {
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly source_system: string;
  readonly external_tenant_id: string;
}

export interface AdmissionRequest extends AdmissionScope {
  readonly external_subject_type: AdmissionSubjectType;
  readonly external_subject_id: string;
  readonly ingress_id: string;
}

export interface ExternalSubjectEvidence {
  readonly membership: "internal" | "external" | "unknown";
  readonly active: boolean | null;
  readonly observed_at: string;
  readonly provider_revision: string;
}

export interface AdmissionPolicy extends AdmissionScope {
  readonly policy_id: string;
  readonly revision: string;
  readonly default: "deny";
  readonly allow: {
    readonly all_internal_members: boolean;
    readonly external_subject_ids: readonly string[];
  };
  readonly deny: { readonly external_subject_ids: readonly string[] };
  readonly internal_membership?: {
    readonly evidence_provider_ref: string;
    readonly positive_ttl_seconds: number;
    readonly negative_ttl_seconds: number;
  };
  readonly binding: { readonly actor_type: AdmissionSubjectType; readonly store_ref: string };
}

export interface ParticipantBinding extends AdmissionScope {
  readonly external_subject_type: AdmissionSubjectType;
  readonly external_subject_fingerprint: string;
  readonly actor_id: string;
  readonly actor_type: AdmissionSubjectType;
  readonly endpoint_id: string;
  readonly created_at: string;
}

export type AdmissionDecision =
  | { readonly kind: "allow"; readonly reason_code: "explicit_allow" | "internal_member"; readonly policy_id: string; readonly policy_revision: string; readonly binding: ParticipantBinding; readonly decision_id: string }
  | { readonly kind: "deny"; readonly reason_code: "explicit_deny" | "not_internal_member" | "inactive_subject" | "default_deny" | "scope_mismatch"; readonly policy_id: string; readonly policy_revision: string; readonly decision_id: string }
  | { readonly kind: "temporarily_unavailable"; readonly reason_code: "policy_unavailable" | "evidence_unavailable" | "store_unavailable" | "grant_unavailable"; readonly retry_after_seconds: number };

export interface AdmissionResult {
  readonly decision: AdmissionDecision;
  readonly representation_grant?: string;
}
```

Define ports with these exact signatures:

```ts
export interface AdmissionPolicyProvider extends ExchangeAdapter {
  load(policyId: string): Promise<AdmissionPolicy | null>;
}

export interface ExternalSubjectEvidenceProvider extends ExchangeAdapter {
  readonly provider_ref: string;
  resolve(request: AdmissionRequest): Promise<ExternalSubjectEvidence>;
}

export interface ExternalSubjectFingerprinter {
  fingerprint(request: AdmissionRequest): string;
}

export interface ParticipantBindingStore extends ExchangeAdapter {
  getOrCreate(input: { readonly request: AdmissionRequest; readonly external_subject_fingerprint: string; readonly actor_id: string; readonly endpoint_id: string; readonly created_at: string }): Promise<ParticipantBinding>;
}

export interface AdmissionDecisionRecord {
  readonly decision: Exclude<AdmissionDecision, { readonly kind: "temporarily_unavailable" }>;
  readonly scope: AdmissionScope;
  readonly ingress_id: string;
  readonly external_subject_fingerprint: string;
  readonly evidence?: Pick<ExternalSubjectEvidence, "membership" | "active" | "observed_at" | "provider_revision">;
  readonly recorded_at: string;
}

export interface AdmissionDecisionStore extends ExchangeAdapter {
  findByIngress(input: AdmissionScope & { readonly ingress_id: string }): Promise<AdmissionDecisionRecord | null>;
  record(input: AdmissionDecisionRecord): Promise<AdmissionDecisionRecord>;
}

export interface RepresentationGrantIssuer {
  issue(input: { readonly request: AdmissionRequest; readonly decision: Extract<AdmissionDecision, { readonly kind: "allow" }>; readonly expires_at: string }): Promise<string>;
}

export interface RepresentationGrantVerifier {
  verify(grant: string, now: string): Promise<{ readonly tenant_id: string; readonly connector_id: string; readonly ingress_id: string; readonly decision_id: string; readonly actor_id: string; readonly actor_type: AdmissionSubjectType; readonly endpoint_id: string; readonly external_subject_fingerprint: string; readonly expires_at: string } | null>;
}

export interface CollaborationAdmissionService {
  admit(policyId: string, request: AdmissionRequest): Promise<AdmissionResult>;
}
```

`validateAdmissionRequest` must require trimmed strings of 1–255 UTF-16 code units, except `ingress_id` which is 1–128; it must reject `external_subject_id === "*"`. Export everything from `index.ts`.

- [ ] **Step 4: Run focused tests and typecheck**

```bash
npx vitest run packages/admission-spi/test/contracts.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit the neutral boundary**

```bash
git add packages/admission-spi package-lock.json
git commit -m "feat(admission): define neutral admission contracts"
```

---

### Task 2: Add immutable global Admission configuration

**Files:**

- Modify: `packages/configuration-runtime/src/configuration-service.ts`
- Modify: `packages/configuration-runtime/test/configuration-service.test.ts`
- Create: `packages/adapter-admission-configuration/package.json`
- Create: `packages/adapter-admission-configuration/src/index.ts`
- Create: `packages/adapter-admission-configuration/src/configuration-policy-provider.ts`
- Create: `packages/adapter-admission-configuration/test/configuration-policy-provider.test.ts`
- Modify: `packages/service-node/src/configuration-loader.ts`
- Modify: `packages/service-node/test/global-configuration.test.ts`

**Interfaces:**

- Consumes: `ConfigurationSnapshot`, `ConfigurationSectionValidator` and `AdmissionPolicyProvider`.
- Produces: immutable named root sections and `ConfigurationAdmissionPolicyProvider`.

- [ ] **Step 1: Write failing section and strict policy tests**

Add tests proving that a root-level `admission` section is validated once, deep-frozen and returned as `snapshot.value.sections.admission`; unknown root keys still fail. Policy tests must reject unknown keys, duplicate IDs, a literal `"*"`, `default: allow`, an internal wildcard without membership configuration, non-human wildcard binding, TTL outside `1..86400`, mismatched map key/policy ID and more than 10,000 allow or deny IDs.

- [ ] **Step 2: Confirm RED**

```bash
npx vitest run packages/configuration-runtime/test/configuration-service.test.ts packages/adapter-admission-configuration/test/configuration-policy-provider.test.ts packages/service-node/test/global-configuration.test.ts
```

Expected: FAIL because named root sections and the Admission configuration adapter do not exist.

- [ ] **Step 3: Extend ConfigurationService without naming Admission**

Add this generic mechanism:

```ts
export interface NamedConfigurationSectionValidator<T = unknown> extends ConfigurationSectionValidator<T> {
  readonly section: string;
}

export interface ConfigurationValue<Service = unknown> {
  readonly api_version: "workfabric.config/v1";
  readonly service: Service;
  readonly plugins: { readonly instances: Readonly<Record<string, PluginInstanceSnapshot>> };
  readonly sections: Readonly<Record<string, unknown>>;
}
```

Add `section_validators?: readonly NamedConfigurationSectionValidator[]` to `ConfigurationServiceOptions`. Build the allowed root keys from `api_version`, `service`, `plugins` and registered section names; validate only present named sections; deep-freeze each normalized result. Existing callers receive `sections: {}` and require no YAML change.

- [ ] **Step 4: Implement strict Admission policy validation and Provider**

Use this configuration shape:

```ts
export interface AdmissionConfigurationSection {
  readonly policies: Readonly<Record<string, AdmissionPolicy>>;
  readonly evidence_providers: Readonly<Record<string, {
    readonly type: string;
    readonly config: Readonly<Record<string, unknown>>;
  }>>;
}

export const admissionConfigurationValidator: NamedConfigurationSectionValidator<AdmissionConfigurationSection> = {
  section: "admission",
  type: "workfabric.admission.configuration.v1",
  validate(value, path) { return validateAdmissionConfiguration(value, path); },
};

export class ConfigurationAdmissionPolicyProvider implements AdmissionPolicyProvider {
  readonly manifest = { profile: "admission.policy-provider.v1", adapter: "configuration", capabilities: { immutable_revision: true, source_neutral: true } } as const;
  constructor(private readonly section: AdmissionConfigurationSection) {}
  async load(policyId: string): Promise<AdmissionPolicy | null> {
    const policy = this.section.policies[policyId];
    return policy === undefined ? null : structuredClone(policy);
  }
}
```

Compile exact IDs later in runtime; this adapter validates, clones and freezes source data only. It must never import the YAML package.

- [ ] **Step 5: Register the section in node configuration loading**

Pass `section_validators: [admissionConfigurationValidator]` to `ConfigurationService` and return the typed section:

```ts
export interface LoadedNodeConfiguration {
  readonly revision: string;
  readonly service: NodeServiceConfig;
  readonly plugins: PluginHostConfiguration;
  readonly admission: AdmissionConfigurationSection;
}
```

Require `admission: { policies: {}, evidence_providers: {} }` only when a plugin selects `identity_admission`; legacy configurations may omit it and normalize to `{ policies: {}, evidence_providers: {} }`. Provider descriptors are immutable installation metadata; the policy Provider reads only `policies`, while `service-node` resolves descriptor `type` values to installed evidence adapter factories.

- [ ] **Step 6: Run regressions and commit**

```bash
npx vitest run packages/configuration-runtime/test packages/adapter-admission-configuration/test packages/service-node/test/global-configuration.test.ts
npm run typecheck
git add packages/configuration-runtime packages/adapter-admission-configuration packages/service-node/src/configuration-loader.ts packages/service-node/test/global-configuration.test.ts package-lock.json
git commit -m "feat(configuration): load immutable admission policies"
```

Expected: all commands PASS.

---

### Task 3: Implement deterministic Admission evaluation

**Files:**

- Create: `packages/admission-runtime/package.json`
- Create: `packages/admission-runtime/src/index.ts`
- Create: `packages/admission-runtime/src/compiled-policy.ts`
- Create: `packages/admission-runtime/src/evidence-cache.ts`
- Create: `packages/admission-runtime/src/collaboration-admission-service.ts`
- Create: `packages/admission-runtime/test/compiled-policy.test.ts`
- Create: `packages/admission-runtime/test/evidence-cache.test.ts`
- Create: `packages/admission-runtime/test/collaboration-admission-service.test.ts`

**Interfaces:**

- Consumes: every port from Task 1 and immutable policies from Task 2.
- Produces: `DefaultCollaborationAdmissionService` with fixed precedence and bounded caching.

- [ ] **Step 1: Write failing precedence, isolation and outage tests**

Cover this exact matrix:

```ts
[
  ["deny beats explicit allow", "deny"],
  ["deny beats internal member", "deny"],
  ["explicit allow skips directory", "allow"],
  ["active internal human is allowed", "allow"],
  ["inactive internal human is denied", "deny"],
  ["external human is denied", "deny"],
  ["unknown human is denied", "deny"],
  ["internal agent still requires exact allow", "deny"],
  ["no match is default deny", "deny"],
  ["scope mismatch is denied", "deny"],
  ["directory outage is retryable", "temporarily_unavailable"],
  ["binding outage is retryable", "temporarily_unavailable"],
  ["decision-store outage is retryable", "temporarily_unavailable"],
]
```

Also assert one policy load per revision, O(1) `Set.has` paths, positive/negative TTL expiry, a maximum cache size option, cached values cloned on return, and an existing decision for the same ingress is reused without a second binding.

- [ ] **Step 2: Confirm RED**

```bash
npx vitest run packages/admission-runtime/test
```

Expected: FAIL because the runtime package does not exist.

- [ ] **Step 3: Compile immutable policy snapshots**

Implement:

```ts
export interface CompiledAdmissionPolicy {
  readonly policy: AdmissionPolicy;
  readonly exact_allow: ReadonlySet<string>;
  readonly exact_deny: ReadonlySet<string>;
}

export function compileAdmissionPolicy(policy: AdmissionPolicy): CompiledAdmissionPolicy {
  return Object.freeze({
    policy: structuredClone(policy),
    exact_allow: new Set(policy.allow.external_subject_ids),
    exact_deny: new Set(policy.deny.external_subject_ids),
  });
}
```

Cache by `policy_id + "\0" + revision`; never mutate a compiled snapshot.

- [ ] **Step 4: Implement a bounded evidence cache**

Use a `Map<string, { evidence: ExternalSubjectEvidence; expires_at_ms: number }>` with insertion-order eviction. The key is `tenant_id + connector_id + source_system + external_tenant_id + subject_type + subject_fingerprint + provider_ref`. Select positive TTL only for `internal && active === true`; otherwise use negative TTL. Reject stale `observed_at` values whose age already exceeds the selected TTL.

- [ ] **Step 5: Implement the orchestration algorithm**

Use this public constructor:

```ts
export interface CollaborationAdmissionServiceOptions {
  readonly policies: AdmissionPolicyProvider;
  readonly evidence_providers: ReadonlyMap<string, ExternalSubjectEvidenceProvider>;
  readonly binding_stores: ReadonlyMap<string, ParticipantBindingStore>;
  readonly decisions: AdmissionDecisionStore;
  readonly fingerprinter: ExternalSubjectFingerprinter;
  readonly grants: RepresentationGrantIssuer;
  readonly clock: { now(): string };
  readonly ids: { decisionId(): string; actorId(fingerprint: string): string; endpointId(fingerprint: string): string };
  readonly grant_ttl_seconds: number;
  readonly retry_after_seconds: number;
  readonly max_evidence_cache_entries: number;
}
```

The implementation order is exact: validate request; load/compile policy; verify scope; fingerprint; reuse existing ingress decision; check deny; check explicit allow; for human wildcard resolve fresh evidence; bind only on allow; record terminal decision; issue grant only after the allow record succeeds. A grant failure returns `grant_unavailable` and does not erase the already recorded allow decision; a retry reuses that decision and reissues the same ingress-bound identity grant.

- [ ] **Step 6: Run focused tests and commit**

```bash
npx vitest run packages/admission-runtime/test
npm run typecheck
git add packages/admission-runtime package-lock.json
git commit -m "feat(admission): evaluate deterministic admission policy"
```

Expected: PASS.

---

### Task 4: Add conformance profiles and Memory persistence

**Files:**

- Create: `packages/admission-conformance/package.json`
- Create: `packages/admission-conformance/src/index.ts`
- Create: `packages/admission-conformance/src/binding-profile.ts`
- Create: `packages/admission-conformance/src/decision-profile.ts`
- Create: `packages/adapter-admission-memory/package.json`
- Create: `packages/adapter-admission-memory/src/index.ts`
- Create: `packages/adapter-admission-memory/src/memory-participant-binding-store.ts`
- Create: `packages/adapter-admission-memory/src/memory-admission-decision-store.ts`
- Create: `packages/adapter-admission-memory/test/memory-admission-stores.test.ts`

**Interfaces:**

- Consumes: binding and decision store ports.
- Produces: reusable adapter profiles plus demo-safe Memory stores.

- [ ] **Step 1: Write adapter profiles before implementations**

`runParticipantBindingStoreProfile(factory)` must prove tenant/source isolation, stable repeated lookup, concurrent `Promise.all` creation convergence, distinct Actor/Endpoint for distinct fingerprints and defensive cloning. `runAdmissionDecisionStoreProfile(factory)` must prove ingress idempotency, conflicting second records are rejected, tenant isolation and that no serialized record contains `external_subject_id`, `representation_grant`, `token`, `secret`, `message` or `content` keys.

- [ ] **Step 2: Confirm RED**

```bash
npx vitest run packages/adapter-admission-memory/test/memory-admission-stores.test.ts
```

Expected: FAIL because the conformance and Memory packages do not exist.

- [ ] **Step 3: Implement atomic in-process stores**

Use collision-safe JSON-encoded tuple keys; never concatenate identifier components with a delimiter that those identifiers may contain. Clone on all boundaries. `getOrCreate` performs one synchronous `Map.get`/`Map.set` segment before resolving its Promise, so concurrent first calls converge in one Node process. `record` returns the existing record only when it is deeply equal; otherwise throw `AdmissionAdapterError("decision_store_unavailable", "admission_decision_conflict")` without including record data.

- [ ] **Step 4: Run profiles and commit**

```bash
npx vitest run packages/adapter-admission-memory/test
npm run typecheck
git add packages/admission-conformance packages/adapter-admission-memory package-lock.json
git commit -m "feat(admission): add memory persistence profiles"
```

Expected: PASS.

---

### Task 5: Add keyed fingerprints and representation grants

**Files:**

- Create: `packages/adapter-identity-admission/package.json`
- Create: `packages/adapter-identity-admission/src/index.ts`
- Create: `packages/adapter-identity-admission/src/hmac-subject-fingerprinter.ts`
- Create: `packages/adapter-identity-admission/src/hmac-representation-grants.ts`
- Create: `packages/adapter-identity-admission/src/admission-identity-provider.ts`
- Create: `packages/adapter-identity-admission/src/composite-identity-provider.ts`
- Create: `packages/adapter-identity-admission/src/admission-principal-trust.ts`
- Create: `packages/adapter-identity-admission/test/hmac-subject-fingerprinter.test.ts`
- Create: `packages/adapter-identity-admission/test/hmac-representation-grants.test.ts`
- Create: `packages/adapter-identity-admission/test/admission-identity-provider.test.ts`

**Interfaces:**

- Consumes: `ExternalSubjectFingerprinter`, `RepresentationGrantIssuer`, `RepresentationGrantVerifier`, `IdentityProvider`.
- Produces: non-correlatable subject fingerprints, rotating HMAC grants and one-claim Identity resolution.

- [ ] **Step 1: Write failing crypto and identity tests**

Assert deterministic same-tenant fingerprints, different outputs for different deployment keys and tenants, no raw ID substring, constant bounded output, grant tamper rejection, expiry, future-issued rejection, key rotation, connector/ingress binding, one Actor claim and fallback to the existing local Identity Provider. Decode the payload in tests and assert it contains no raw external subject ID and no App credential.

- [ ] **Step 2: Confirm RED**

```bash
npx vitest run packages/adapter-identity-admission/test
```

Expected: FAIL because the package does not exist.

- [ ] **Step 3: Implement tenant-scoped fingerprints**

Use HMAC-SHA-256 with a deployment secret of at least 32 UTF-8 bytes. Encode the
input as one deterministic JSON string tuple so identifier components cannot
collide even when they contain delimiter characters:

```ts
HMAC(key, JSON.stringify([
  "workfabric-admission-subject-v1",
  tenant_id,
  connector_id,
  source_system,
  external_tenant_id,
  external_subject_type,
  external_subject_id,
]))
```

Return `afp_` plus base64url digest. Never log the input or key.

- [ ] **Step 4: Implement rotating short-lived grants**

Use compact `base64url(canonical JSON) + "." + base64url(HMAC-SHA-256(active key, payload))`. The payload is exactly:

```ts
interface AdmissionGrantPayload {
  readonly v: 1;
  readonly kid: string;
  readonly grant_id: string;
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly ingress_id: string;
  readonly decision_id: string;
  readonly actor_id: string;
  readonly actor_type: "human" | "agent" | "system";
  readonly endpoint_id: string;
  readonly external_subject_fingerprint: string;
  readonly issued_at: string;
  readonly expires_at: string;
}
```

The constructor takes `{ active_key_id, keys: Readonly<Record<string, Uint8Array>>, clock, ids }`; every key is at least 32 bytes, unknown `kid` fails, signature comparison uses `timingSafeEqual`, lifetime is at most 300 seconds, and issuance more than 30 seconds in the future fails verification.

- [ ] **Step 5: Resolve exactly one dynamic Actor claim**

`AdmissionIdentityProvider.resolve` accepts only `{ bearer_token: string }`, verifies the grant and returns:

```ts
{
  principal_id: `admission:${payload.connector_id}`,
  tenant_id: payload.tenant_id,
  actor_claims: [{ actor_id: payload.actor_id, actor_type: payload.actor_type, endpoint_ids: [payload.endpoint_id] }],
  attributes: {
    "workfabric.dev/identity_kind": "admission",
    "workfabric.dev/connector_id": payload.connector_id,
    "workfabric.dev/ingress_id": payload.ingress_id,
    "workfabric.dev/decision_id": payload.decision_id,
  },
}
```

Create `AdmissionPrincipalTrust` around a private `WeakSet<ResolvedPrincipal>`. `AdmissionIdentityProvider` freezes and marks the exact principal object it returns; `isTrusted(principal)` succeeds only for that object identity. `CompositeIdentityProvider` tries providers in constructor order, returns the first non-null object without cloning it and rejects duplicate provider manifests at construction. This in-process trust handoff prevents a statically configured principal from forging Admission-looking JSON attributes.

- [ ] **Step 6: Run tests and commit**

```bash
npx vitest run packages/adapter-identity-admission/test
npm run typecheck
git add packages/adapter-identity-admission package-lock.json
git commit -m "feat(admission): issue bounded representation grants"
```

Expected: PASS.

---

### Task 6: Keep dynamic admission behind explicit Authority

**Files:**

- Create: `packages/adapter-authority-admission/package.json`
- Create: `packages/adapter-authority-admission/src/index.ts`
- Create: `packages/adapter-authority-admission/src/admission-authority-policy.ts`
- Create: `packages/adapter-authority-admission/src/composite-authority-policy.ts`
- Create: `packages/adapter-authority-admission/test/admission-authority-policy.test.ts`

**Interfaces:**

- Consumes: `AuthorityPolicy`, trusted attributes and the `AdmissionPrincipalTrust` instance produced by Task 5.
- Produces: narrow Intake authorization and ordered authority composition.

- [ ] **Step 1: Write failing boundary tests**

Prove that an admission principal may perform only `workfabric.handoff.offer.v1` with `resource_id === null`, only for its single represented Actor/Endpoint, and only when connector and tenant match an explicit rule. Deny Accept, result reporting, verification, administration, queries, another endpoint, another connector and a forged local principal with similar text attributes.

- [ ] **Step 2: Confirm RED**

```bash
npx vitest run packages/adapter-authority-admission/test
```

Expected: FAIL because the package does not exist.

- [ ] **Step 3: Implement exact connector authority rules**

Use:

```ts
export interface AdmissionAuthorityRule {
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly principal_id: string;
  readonly action: "workfabric.handoff.offer.v1";
}
```

Require `trust.isTrusted(request.principal)`, `principal_id === "admission:" + connector_id`, trusted identity kind and connector attributes, an Actor claim matching the request, `request.action === rule.action` and `request.resource_id === null`. `CompositeAuthorityPolicy` returns allow on the first allow; otherwise it returns a stable generic deny without concatenating adapter reasons.

- [ ] **Step 4: Run tests and commit**

```bash
npx vitest run packages/adapter-authority-admission/test
npm run typecheck
git add packages/adapter-authority-admission package-lock.json
git commit -m "feat(admission): authorize intake through explicit policy"
```

Expected: PASS.

---

### Task 7: Add command-scoped SDK authentication

**Files:**

- Modify: `packages/connector-spi/src/mapping.ts`
- Modify: `packages/connector-spi/test/contracts.test.ts`
- Modify: `packages/connector-runtime/src/connector-worker.ts`
- Modify: `packages/connector-runtime/test/connector-worker.test.ts`
- Modify: `packages/sdk-typescript/src/client.ts`
- Modify: `packages/sdk-typescript/src/connector-command-sink.ts`
- Modify: `packages/sdk-typescript/test/client-composition.test.ts`
- Modify: `packages/sdk-typescript/test/connector-command-sink.test.ts`

**Interfaces:**

- Consumes: the representation grant returned by Admission.
- Produces: a command-only bearer credential presented through normal HTTP authentication and removed from receipts.

- [ ] **Step 1: Write failing credential-isolation tests**

Assert that a command with a grant sends `Authorization: Bearer <grant>` and Actor/Endpoint headers, while the base client still uses its configured token before and after the call. Assert the accepted receipt handler receives no authentication field and serialized receipt content does not contain the grant.

- [ ] **Step 2: Confirm RED**

```bash
npx vitest run packages/connector-spi/test/contracts.test.ts packages/connector-runtime/test/connector-worker.test.ts packages/sdk-typescript/test/client-composition.test.ts packages/sdk-typescript/test/connector-command-sink.test.ts
```

Expected: FAIL because commands cannot carry scoped authentication and clients cannot derive authentication safely.

- [ ] **Step 3: Extend the neutral command contract**

Require Actor type and add an opaque command-only credential:

```ts
export interface ConnectorResolvedIdentity {
  readonly actor_id: string;
  readonly actor_type: "human" | "agent" | "system";
  readonly endpoint_id?: string;
  readonly delegation_id?: string;
}

export interface ConnectorCommandAuthentication {
  readonly kind: "bearer";
  readonly credential: string;
}

export interface ConnectorCommandDescriptor {
  readonly operation: string;
  readonly idempotency_key: string;
  readonly expected_version?: number;
  readonly identity: ConnectorResolvedIdentity;
  readonly authentication?: ConnectorCommandAuthentication;
  readonly input: JsonObject;
}

export type AuditableConnectorCommandDescriptor = Omit<ConnectorCommandDescriptor, "authentication">;
```

Change `ConnectorAcceptedReceipt.command` to `AuditableConnectorCommandDescriptor`. Before calling a receipt handler, `ConnectorWorker` constructs a new object containing only operation, idempotency key, optional expected version, cloned identity and cloned input.

- [ ] **Step 4: Add immutable client derivation**

Implement `WorkFabricClient.withAuthentication(authentication: AuthenticationProvider)` by composing a new `SdkTransport` from `{ ...this.config, authentication }`; do not mutate or share the old transport for this derived client. Keep `withRepresentation` behavior unchanged.

In `ConnectorSdkCommandSink.execute`, choose:

```ts
const client = command.authentication?.kind === "bearer"
  ? this.client.withAuthentication(new BearerTokenProvider(command.authentication.credential))
  : this.client;
const handoffs = client.withRepresentation({ actorId: command.identity.actor_id, endpointId: command.identity.endpoint_id, ...(command.identity.delegation_id === undefined ? {} : { delegationId: command.identity.delegation_id }) }).handoffs;
```

Never include the credential in thrown errors, receipt details or telemetry.

- [ ] **Step 5: Update existing connector identity fixtures and run regressions**

Add `actor_type` to every `ConnectorResolvedIdentity` fixture and lookup. Replace Feishu receipt `actor_type_for` lookup with `input.command.identity.actor_type`.

```bash
npx vitest run packages/connector-spi/test packages/connector-runtime/test packages/sdk-typescript/test packages/connector-feishu/test packages/plugin-channel-feishu/test
npm run typecheck
git add packages/connector-spi packages/connector-runtime packages/sdk-typescript packages/connector-feishu packages/plugin-channel-feishu
git commit -m "feat(sdk): support command scoped representation"
```

Expected: PASS and no receipt snapshot contains a bearer credential.

---

### Task 8: Implement SQLite and PostgreSQL Admission adapters

**Files:**

- Create: `packages/adapter-admission-sqlite/package.json`
- Create: `packages/adapter-admission-sqlite/src/index.ts`
- Create: `packages/adapter-admission-sqlite/src/sqlite-admission-stores.ts`
- Create: `packages/adapter-admission-sqlite/test/sqlite-admission-stores.test.ts`
- Create: `packages/adapter-admission-sqlite/migrations/005_admission.sql`
- Create: `packages/adapter-admission-postgres/package.json`
- Create: `packages/adapter-admission-postgres/src/index.ts`
- Create: `packages/adapter-admission-postgres/src/postgres-admission-stores.ts`
- Create: `packages/adapter-admission-postgres/test/postgres-admission-stores.test.ts`
- Create: `packages/adapter-admission-postgres/migrations/010_admission.sql`
- Modify: `tools/postgres-migrate.ts`
- Modify: `tools/postgres-tools.test.ts`

**Interfaces:**

- Consumes: conformance profiles, `SqliteSession`, `PostgresClient` and tenant session conventions.
- Produces: restart-safe SQLite and cluster-safe PostgreSQL binding/decision authority.

- [ ] **Step 1: Write failing conformance and migration tests**

Run both adapters through Task 4 profiles. Add SQLite restart and concurrent upsert tests. Add PostgreSQL migration assertions for composite uniqueness and row-level security; when `WORK_FABRIC_TEST_POSTGRES_URL` is present, run two-client concurrent creation and tenant-isolation integration tests.

- [ ] **Step 2: Confirm RED**

```bash
npx vitest run packages/adapter-admission-sqlite/test packages/adapter-admission-postgres/test packages/adapter-storage-sqlite/test/sqlite-exchange.test.ts packages/adapter-postgres-common/test/migrations.test.ts
```

Expected: FAIL because the adapters and migrations do not exist.

- [ ] **Step 3: Add the storage schema**

Export `SQLITE_ADMISSION_MIGRATION` and `POSTGRES_ADMISSION_MIGRATION` from their respective adapter packages. Create binding tables with a unique key over tenant, connector, source, external tenant, subject type and fingerprint, plus unique tenant-scoped Actor and Endpoint IDs. Create decision tables with a unique key over tenant, connector, source, external tenant and ingress ID. Store reason codes, policy ID/revision, fingerprint, optional Actor/Endpoint and bounded evidence metadata in typed columns; do not add raw subject ID, message payload or grant columns.

PostgreSQL tables must enable and force RLS using `work_fabric_current_tenant()`. SQLite statements must always include `tenant_id = ?`; constructors bind one tenant.

Append `POSTGRES_ADMISSION_MIGRATION` to `POSTGRES_MIGRATIONS` in `tools/postgres-migrate.ts` and assert `010_admission` in the dry-run plan. Do not make the base storage packages depend on Admission adapters. Task 11 passes `[...SQLITE_MIGRATIONS, SQLITE_ADMISSION_MIGRATION]` to `migrateSqlite` when Admission is enabled.

- [ ] **Step 4: Implement transactional get-or-create and idempotent decision recording**

SQLite uses `BEGIN IMMEDIATE`, `INSERT ... ON CONFLICT DO NOTHING`, then exact-key `SELECT`. PostgreSQL uses one transaction and `INSERT ... ON CONFLICT (...) DO UPDATE SET external_subject_fingerprint = EXCLUDED.external_subject_fingerprint RETURNING ...`; decision conflicts compare every persisted semantic field before returning.

Translate database errors into stable `AdmissionAdapterError` codes without SQL text or values.

- [ ] **Step 5: Run adapter verification and commit**

```bash
npx vitest run packages/adapter-admission-sqlite/test packages/adapter-admission-postgres/test packages/adapter-storage-sqlite/test tools/postgres-tools.test.ts packages/adapter-postgres-common/test/migrations.test.ts
npm run typecheck
git add packages/adapter-admission-sqlite packages/adapter-admission-postgres tools/postgres-migrate.ts tools/postgres-tools.test.ts package-lock.json
git commit -m "feat(admission): persist bindings and decisions"
```

Expected: PASS; PostgreSQL live integration may report skipped only when its explicit test URL is absent.

---

### Task 9: Add Feishu directory membership evidence

**Files:**

- Create: `packages/adapter-directory-feishu/package.json`
- Create: `packages/adapter-directory-feishu/src/index.ts`
- Create: `packages/adapter-directory-feishu/src/feishu-directory-evidence-provider.ts`
- Create: `packages/adapter-directory-feishu/test/feishu-directory-evidence-provider.test.ts`
- Modify: `packages/connector-feishu/src/open-api-client.ts`
- Modify: `packages/connector-feishu/test/open-api-client.test.ts`

**Interfaces:**

- Consumes: `ExternalSubjectEvidenceProvider` and the existing tenant access token provider.
- Produces: bounded `internal|external|unknown` facts for Feishu `open_id` users.

- [ ] **Step 1: Write failing directory semantics tests**

Test one active directory user, a deleted/inactive user, no returned item, Feishu nonzero API code, 401/403, 429/5xx, timeout, oversized body, malformed JSON and wrong external tenant scope. Assert only `open_id`, `status.is_activated` and `status.is_exited` are retained; names, mobile numbers, emails, avatars and the raw response never leave the adapter.

- [ ] **Step 2: Confirm RED**

```bash
npx vitest run packages/adapter-directory-feishu/test packages/connector-feishu/test/open-api-client.test.ts
```

Expected: FAIL because the evidence adapter does not exist.

- [ ] **Step 3: Implement the official Contact API boundary**

Call:

```text
GET https://open.feishu.cn/open-apis/contact/v3/users/batch?user_ids=<encoded-open-id>&user_id_type=open_id
Authorization: Bearer <tenant_access_token>
Content-Type: application/json; charset=utf-8
```

The API is documented at `https://open.feishu.cn/document/contact-v3/user/batch`. Use a 10-second timeout and 64 KiB response limit. Exactly one returned matching `open_id` with `is_activated === true` and `is_exited !== true` yields `{ membership: "internal", active: true }`. A matching inactive/exited item yields `{ membership: "internal", active: false }`. No matching item yields `{ membership: "unknown", active: null }`; it must not be promoted to `external` because application directory visibility may be restricted. Transport, permission, rate-limit and response failures throw `AdmissionAdapterError("evidence_unavailable", "feishu_directory_unavailable")`.

- [ ] **Step 4: Run focused tests and commit**

```bash
npx vitest run packages/adapter-directory-feishu/test packages/connector-feishu/test/open-api-client.test.ts
npm run typecheck
git add packages/adapter-directory-feishu packages/connector-feishu package-lock.json
git commit -m "feat(feishu): provide directory membership evidence"
```

Expected: PASS.

---

### Task 10: Integrate Admission at the Feishu participant boundary

**Files:**

- Modify: `packages/connector-feishu/src/event-mapper.ts`
- Modify: `packages/connector-feishu/test/event-mapper.test.ts`
- Modify: `packages/plugin-channel-feishu/src/config.ts`
- Modify: `packages/plugin-channel-feishu/src/feishu-plugin-factory.ts`
- Modify: `packages/plugin-channel-feishu/src/intake-message-policy.ts`
- Modify: `packages/plugin-channel-feishu/src/intake-receipt-handler.ts`
- Modify: `packages/plugin-channel-feishu/test/config.test.ts`
- Modify: `packages/plugin-channel-feishu/test/feishu-plugin-factory.test.ts`
- Modify: `packages/plugin-channel-feishu/test/intake-message-policy.test.ts`

**Interfaces:**

- Consumes: `CollaborationAdmissionService`, a configured policy ID and normalized Feishu sender/operator facts.
- Produces: command identity plus command-scoped representation grant; no Feishu-local precedence.

- [ ] **Step 1: Write failing config migration and mapper tests**

Accept exactly one of:

```yaml
identities:
  - external_open_id: ou-user
    actor_id: actor-user
    actor_type: human
    endpoint_id: endpoint-user
```

or:

```yaml
identity_admission:
  policy_id: feishu-primary-participants
```

Reject both, neither, unknown keys and a policy scope mismatch. Test exact deny, exact allow, active internal wildcard, guest/unknown deny, retryable evidence outage, duplicate ingress, stable Actor/Endpoint and both message and card-action participant paths.

- [ ] **Step 2: Confirm RED**

```bash
npx vitest run packages/connector-feishu/test/event-mapper.test.ts packages/plugin-channel-feishu/test/config.test.ts packages/plugin-channel-feishu/test/feishu-plugin-factory.test.ts packages/plugin-channel-feishu/test/intake-message-policy.test.ts
```

Expected: FAIL because the plugin supports only static identities.

- [ ] **Step 3: Add a Feishu participant resolution port**

Define in `connector-feishu`:

```ts
export type FeishuParticipantResolution =
  | { readonly kind: "resolved"; readonly identity: ConnectorResolvedIdentity; readonly representation_grant?: string }
  | { readonly kind: "denied"; readonly reason_code: string }
  | { readonly kind: "temporarily_unavailable"; readonly reason_code: string };

export interface FeishuParticipantResolver {
  resolve(input: { readonly claim: ConnectorIngressClaim; readonly external_subject_id: string; readonly external_subject_type: "human" }): Promise<FeishuParticipantResolution>;
}
```

Both card actions and Intake messages call this port. A denied result maps to permanent Connector rejection; unavailable maps to retryable rejection. A resolved grant is placed only in `command.authentication = { kind: "bearer", credential: grant }`.

- [ ] **Step 4: Keep legacy identities as a compatibility adapter**

The plugin-local legacy resolver performs only exact map lookup and returns no grant. The Admission resolver calls:

```ts
admission.admit(config.identity_admission.policy_id, {
  tenant_id: tenantId,
  connector_id: config.connector_id,
  source_system: "feishu",
  external_tenant_id: config.external_tenant_id,
  external_subject_type: "human",
  external_subject_id: input.external_subject_id,
  ingress_id: input.claim.ingress_id,
});
```

It converts allow binding fields into `ConnectorResolvedIdentity`; denies and retryable outcomes retain only stable reason codes. The factory obtains `CollaborationAdmissionService` from capability `collaboration.admission` only when `identity_admission` is selected.

- [ ] **Step 5: Run Feishu regressions and commit**

```bash
npx vitest run packages/connector-feishu/test packages/plugin-channel-feishu/test
npm run check:plugin-boundaries
npm run typecheck
git add packages/connector-feishu packages/plugin-channel-feishu
git commit -m "feat(feishu): admit participants through shared policy"
```

Expected: PASS; neither package contains grant signing keys, persistence code or precedence logic.

---

### Task 11: Compose Admission for Memory, SQLite and PostgreSQL deployments

**Files:**

- Modify: `packages/service-node/src/config.ts`
- Modify: `packages/service-node/src/configuration-loader.ts`
- Modify: `packages/service-node/src/compose.ts`
- Modify: `packages/service-node/src/main.ts`
- Modify: `packages/service-node/test/config.test.ts`
- Modify: `packages/service-node/test/memory-composition.integration.test.ts`
- Modify: `packages/service-node/test/sqlite-restart.integration.test.ts`
- Modify: `packages/service-node/test/plugin-composition.integration.test.ts`
- Modify: `packages/service-node/test/cluster-composition.integration.test.ts`
- Modify: `examples/config/service-feishu-long-connection.yaml`

**Interfaces:**

- Consumes: all Admission adapters and the existing plugin service locator.
- Produces: one explicit composition root with replaceable Provider/store dependencies.

- [ ] **Step 1: Write failing composition and startup validation tests**

Cover missing policy, missing evidence provider, scope mismatch, invalid key length, unsupported Memory without development mode, SQLite restart stability and PostgreSQL deployment-owned adapter injection. Prove an `api` or `all` role running an Admission-backed connector can both evaluate Admission and verify the resulting grant, and prove separately composed service processes accept the same configured verification-key set during rotation.

- [ ] **Step 2: Confirm RED**

```bash
npx vitest run packages/service-node/test/config.test.ts packages/service-node/test/memory-composition.integration.test.ts packages/service-node/test/sqlite-restart.integration.test.ts packages/service-node/test/plugin-composition.integration.test.ts packages/service-node/test/cluster-composition.integration.test.ts
```

Expected: FAIL because service composition has no Admission dependencies.

- [ ] **Step 3: Add deployment configuration and secret declarations**

Extend service config with:

```ts
readonly admission?: {
  readonly subject_fingerprint_key: string;
  readonly grant_active_key_id: string;
  readonly grant_keys: Readonly<Record<string, string>>;
  readonly grant_ttl_seconds: number;
  readonly max_evidence_cache_entries: number;
};
```

Declare every key under `service.admission` as a secret path. Require at least 32 UTF-8 bytes after resolution, 1–300 second grant TTL, 1–100,000 cache entries and an active key present in `grant_keys`. Never print resolved values.

- [ ] **Step 4: Compose replaceable dependencies**

Extend `NodeStorageComposition` with `admissionBindings` and `admissionDecisions`. Memory and SQLite profiles construct their matching adapters. PostgreSQL continues to receive deployment-owned `postgres_storage`, now including the two Admission stores; `service-node` does not create PostgreSQL credentials or clients.

Construct `DefaultCollaborationAdmissionService`, register it as `collaboration.admission`, compose local and Admission Identity providers, and compose local and Admission Authority policies. Derive Admission authority rules only from enabled plugin instances that select `identity_admission`, always with action `workfabric.handoff.offer.v1`.

For each `admission.evidence_providers` descriptor with `type: "feishu.directory"`, require exactly `{ plugin_instance_id: string }`, locate that enabled Feishu plugin's resolved credentials, reuse its tenant access-token provider, and construct `FeishuDirectoryEvidenceProvider` under the descriptor map key. No App Secret is copied into the policy snapshot or Admission runtime.

- [ ] **Step 5: Enforce startup scope checks**

For every enabled Admission-backed plugin, load the named policy and require exact equality of tenant, connector, `source_system === "feishu"` and external tenant before `pluginHost.prepare()`. Require the policy's evidence provider reference to exist when internal wildcard is enabled. Fail with stable configuration codes and paths, not secret values.

- [ ] **Step 6: Update the example configuration**

Replace the static Feishu identity example with:

```yaml
service:
  admission:
    subject_fingerprint_key: ${WORK_FABRIC_ADMISSION_FINGERPRINT_KEY}
    grant_active_key_id: primary
    grant_keys:
      primary: ${WORK_FABRIC_ADMISSION_GRANT_KEY}
    grant_ttl_seconds: 120
    max_evidence_cache_entries: 10000

admission:
  evidence_providers:
    feishu-directory-primary:
      type: feishu.directory
      config:
        plugin_instance_id: feishu-primary
  policies:
    feishu-primary-participants:
      policy_id: feishu-primary-participants
      revision: "1"
      tenant_id: tenant-local
      connector_id: feishu-primary
      source_system: feishu
      external_tenant_id: tenant-key-example
      default: deny
      allow:
        all_internal_members: true
        external_subject_ids: []
      deny:
        external_subject_ids: []
      internal_membership:
        evidence_provider_ref: feishu-directory-primary
        positive_ttl_seconds: 300
        negative_ttl_seconds: 60
      binding:
        actor_type: human
        store_ref: participant-bindings
```

Set the plugin to `identity_admission.policy_id: feishu-primary-participants` and remove `identities`.

- [ ] **Step 7: Run composition verification and commit**

```bash
npx vitest run packages/service-node/test
npm run check:plugin-boundaries
npm run check:sensitive-observability
npm run typecheck
git add packages/service-node examples/config/service-feishu-long-connection.yaml
git commit -m "feat(service): compose collaboration admission"
```

Expected: PASS except the separately documented date-sensitive Phase 5 test must first be fixed in Task 12 before the final suite.

---

### Task 12: Prove boundaries, end-to-end behavior and operator guidance

**Files:**

- Create: `tools/check-admission-boundaries.ts`
- Create: `tools/check-admission-boundaries.test.ts`
- Modify: `tools/check-sensitive-observability.ts`
- Modify: `package.json`
- Create: `packages/service-node/test/admission-feishu.e2e.test.ts`
- Create: `packages/service-node/test/admission-synthetic-channel.e2e.test.ts`
- Modify: `packages/service-node/test/phase-5-roundtrip.integration.test.ts`
- Modify: `docs/architecture.md`
- Modify: `docs/guides/feishu-collaboration-channel.md`
- Modify: `docs/roadmap.md`

**Interfaces:**

- Consumes: the completed vertical slice.
- Produces: automated proof that Admission remains a connection-boundary capability and the project can be configured safely.

- [ ] **Step 1: Write the failing boundary scanner**

Add `check:admission-boundaries` and reject:

- Feishu/WeCom/Slack SDK imports from `admission-spi` or `admission-runtime`;
- Admission imports from `wfpp`, `exchange-spi`, `exchange-core` or `exchange-runtime`;
- YAML, SQLite or PostgreSQL imports from Admission SPI/runtime;
- policy precedence code in channel plugins;
- grant keys or raw subject fields in logs, metrics, decisions or Console sources;
- direct ExchangeApplication use from channel plugins.

- [ ] **Step 2: Write end-to-end tests before scanner fixes**

The Feishu test must prove exact allow creates one Handoff, exact deny creates none even for an internal user, internal wildcard creates a stable unique binding, unknown/guest fails closed, duplicate events create one decision/binding/Handoff, directory outage retries then recovers, and webhook/long-connection envelopes produce the same result. Assert the command traversed SDK fetch, Admission Identity and Admission Authority.

The synthetic channel test must use `source_system: "synthetic"` with no Feishu import and prove the same Admission runtime admits and binds an exact-allowed system participant.

- [ ] **Step 3: Remove the unrelated date-sensitive test failure**

In `phase-5-roundtrip.integration.test.ts`, replace hard-coded due dates with dates derived from that test's injected clock:

```ts
const acceptBy = addUtcTimestampSeconds(clock.now(), 300);
const resultDueAt = addUtcTimestampSeconds(clock.now(), 3_600);
```

Use those values consistently in offer and result operations so the test proves protocol timing instead of depending on the wall date.

- [ ] **Step 4: Update architecture and Feishu guidance**

Document this fixed sequence:

```text
Feishu transport trust -> durable ingress -> Admission -> representation grant
-> public TypeScript SDK -> HTTP Identity -> Authority -> Exchange Core -> Handoff
```

Explain tenant allowlist, denylist and `all_internal_members`; required Feishu Contact permission and application directory visibility; secret environment variables; migration from `identities`; SQLite versus PostgreSQL behavior; revocation latency bounded by grant TTL; and why group membership, message text and Agent reasoning are outside Admission.

- [ ] **Step 5: Run final verification**

```bash
npm run check:admission-boundaries
npm run check:plugin-boundaries
npm run check:sensitive-observability
npm run typecheck
npm test
npm run conformance
npm run console:build
git diff --check
```

Expected: every command PASS with no skipped repository-owned unit or end-to-end test. PostgreSQL live tests may skip only when `WORK_FABRIC_TEST_POSTGRES_URL` is absent.

- [ ] **Step 6: Commit the complete verified slice**

```bash
git add package.json tools packages/service-node/test docs
git commit -m "test(admission): verify collaboration boundary end to end"
```

---

## Final Acceptance Review

Before declaring implementation complete, verify all of the following against the design specification:

- Admission packages have no channel SDK, YAML, database-driver or Exchange Core dependency.
- Feishu plugin contains configuration selection and translation only, never rule precedence.
- An allowed external participant receives a stable unique Actor/Endpoint and a short-lived single-subject grant.
- Admission Identity returns exactly one Actor claim.
- Admission Authority grants only Intake offer and remains separate from Admission evaluation.
- Every accepted Intake command visibly traverses public SDK, HTTP Identity and Authority.
- Deny, guest, unknown member and outage cases create no Handoff.
- Decision records and operational output contain fingerprints and stable codes only.
- Memory, SQLite and PostgreSQL adapters pass the same conformance profiles.
- A synthetic non-Feishu connector reuses the same runtime.
- Documentation describes Work Fabric as a collaboration connection and handoff fabric, not an automation brain or generalized firewall.
