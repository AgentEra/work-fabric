# Work Fabric Collaboration Admission Layer Design

**Status:** Draft for user review
**Date:** 2026-07-20

## 1. Decision summary

Work Fabric will own a technology-neutral Collaboration Admission Layer at the
connection boundary. It answers one question: may this authenticated external
participant enter the collaboration network through this connector?

The layer is independent from Feishu and from Exchange Core. Feishu, WeCom,
Slack, HTTP, Agent Gateway and future bindings supply authenticated source and
subject facts through adapters. Admission applies deterministic tenant-scoped
policy, binds an allowed external subject to one Work Fabric Actor/Endpoint,
and records a bounded decision receipt.

Admission is not a network firewall, Agent brain, content-moderation system or
business approval engine. It does not choose a target, interpret a message,
create a requirement or execute work.

## 2. Project-boundary fit

Work Fabric exists to connect participants and transfer responsibility. It
therefore must protect the point at which an external participant becomes a
Work Fabric participant. Only Work Fabric knows the connector scope, internal
tenant, Actor/Endpoint binding and protocol operation that follow from that
transition.

The security boundaries remain separate:

1. **Transport trust:** an Adapter authenticates the external service, validates
   tenant/source binding and bounds the payload.
2. **Collaboration admission:** this design decides whether the external
   participant may enter through that trusted connection.
3. **Protocol authority:** the existing `AuthorityPolicy` decides what an
   admitted Actor may do to a specific resource.
4. **Participant execution:** external humans, Agents and systems decide and do
   the actual work.

Admission must not replace Feishu IAM, enterprise directories, WAF/DDoS
protection, credential management, existing Authority or external Agent
reasoning.

## 3. Scope

This design includes:

- independent Admission SPI and runtime packages;
- tenant- and connector-scoped policy selection;
- explicit bulk allowlists;
- independent denylists that coexist with allow rules;
- an explicit `all_internal_members` rule, never a bare `*` subject ID;
- source-neutral internal-membership evidence;
- one stable Actor/Endpoint binding per admitted external subject;
- bounded, auditable, default-deny decisions;
- YAML as the first policy Provider and replaceable database/remote Providers;
- a Feishu directory adapter for internal-member evidence;
- scalable, short-lived representation grants for public-SDK calls;
- Memory, SQLite and PostgreSQL binding/audit adapters;
- compatibility migration from the current Feishu `identities` list;
- contract, precedence, isolation, concurrency and end-to-end tests.

This design does not include:

- message content classification, sensitive-word policy or prompt filtering;
- fraud/risk scoring, business approval or human review queues;
- network firewall, IP allowlist, DDoS or bot-detection infrastructure;
- target selection, scheduling, workflow automation or Agent execution;
- replacement of external identity providers or corporate directories;
- a channel-specific Handoff state machine;
- changes to WFPP or Exchange Core domain semantics.

Rate and quota enforcement may later consume the same subject identity but is
a separate boundary policy, not part of the first Admission contract.

## 4. Chosen approach and alternatives

Use an in-process, source-neutral Admission runtime behind SPIs. The service
composition root supplies policy, membership, binding, grant and audit
adapters. A channel plugin names a policy; it does not implement rule
precedence.

Rejected alternatives:

1. **Keep rules inside each channel plugin.** This is initially smaller but
   duplicates policy across Feishu, WeCom and Agent bindings and couples every
   Provider to every plugin.
2. **Admit everybody as one shared Actor.** This loses attribution, independent
   revocation, ownership, verification and audit integrity.
3. **Bind directly to OPA, Cedar or another engine.** Those may be implemented
   later as policy adapters, but choosing one now would couple module names and
   contracts to a technology before it is required.

## 5. Architecture

```text
External service
  -> transport Adapter authenticates source and bounds event
  -> durable Connector ingress accepts trusted-source fact
  -> Connector worker constructs AdmissionRequest
  -> CollaborationAdmissionService
       -> AdmissionPolicyProvider
       -> ExternalSubjectEvidenceProvider
       -> ParticipantBindingStore
       -> AdmissionDecisionStore
       -> RepresentationGrantIssuer
  -> Connector mapper constructs explicit public operation
  -> public TypeScript SDK with one bounded representation grant
  -> IdentityProvider resolves one trusted Actor claim
  -> AuthorityPolicy authorizes the requested action/resource
  -> Exchange Core records Handoff fact
```

The Admission layer sits after trusted-source durable acceptance and before
identity representation and command execution. Invalid transport signatures,
wrong application/tenant bindings and structurally invalid events are rejected
before ingress. A valid external event is durably accepted before asynchronous
membership lookup so connector callback latency remains bounded and outages can
be retried without pretending the event was processed.

### 5.1 Package responsibilities

- `admission-spi`: source-neutral request, evidence, decision, policy Provider,
  binding store, decision store and representation-grant contracts.
- `admission-runtime`: deterministic evaluation, policy snapshot compilation,
  provider orchestration, bounded caching and decision recording.
- `adapter-admission-configuration`: reads Admission policies from the global
  immutable Configuration snapshot; it does not know YAML APIs.
- `adapter-admission-memory`, `adapter-admission-sqlite` and
  `adapter-admission-postgres`: binding and decision persistence.
- `adapter-directory-feishu`: obtains bounded Feishu member evidence behind the
  source-neutral evidence SPI.
- `adapter-identity-admission`: validates short-lived representation grants and
  returns a `ResolvedPrincipal` containing exactly one Actor/Endpoint claim.
- `plugin-channel-feishu`: constructs an Admission request from normalized
  message facts and consumes the decision; it contains no precedence logic.
- `service-node`: composition root only.

WFPP, Exchange Core, `exchange-spi`, Connector ingress storage and channel
signal routing remain transport- and policy-engine-neutral.

## 6. Core contracts

The exact field bounds will be fixed in the implementation plan and schemas;
the semantic contract is:

```ts
export interface AdmissionRequest {
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly source_system: string;
  readonly external_tenant_id: string;
  readonly external_subject_type: "human" | "agent" | "system";
  readonly external_subject_id: string;
  readonly ingress_id: string;
}

export interface ExternalSubjectEvidence {
  readonly membership: "internal" | "external" | "unknown";
  readonly active: boolean | null;
  readonly observed_at: string;
  readonly provider_revision: string;
}

export type AdmissionDecision =
  | {
      readonly kind: "allow";
      readonly reason_code: "explicit_allow" | "internal_member";
      readonly policy_id: string;
      readonly policy_revision: string;
      readonly binding: {
        readonly actor_id: string;
        readonly actor_type: "human" | "agent" | "system";
        readonly endpoint_id: string;
      };
      readonly decision_id: string;
    }
  | {
      readonly kind: "deny";
      readonly reason_code:
        | "explicit_deny"
        | "not_internal_member"
        | "inactive_subject"
        | "default_deny"
        | "scope_mismatch";
      readonly policy_id: string;
      readonly policy_revision: string;
      readonly decision_id: string;
    }
  | {
      readonly kind: "temporarily_unavailable";
      readonly reason_code: "evidence_unavailable" | "store_unavailable";
      readonly retry_after_seconds: number;
    };
```

`ExternalSubjectEvidenceProvider` owns no policy. It reports facts from the
external directory. `AdmissionPolicyProvider` owns no Feishu calls. A Provider
document is immutable and versioned so every decision names the exact policy
revision used.

## 7. Policy model

Policies are global deployment configuration and are referenced by connector
instances. This keeps policy independent while preventing a connector from
selecting arbitrary policy at runtime.

```yaml
admission:
  policies:
    feishu-primary-participants:
      scope:
        tenant_id: tenant-local
        connector_id: feishu-primary
        source_system: feishu
        external_tenant_id: 16c27df0ae549758

      default: deny

      allow:
        all_internal_members: true
        external_subject_ids:
          - ou_explicit_user_1
          - ou_explicit_user_2

      deny:
        external_subject_ids:
          - ou_blocked_user_1

      internal_membership:
        evidence_provider_ref: feishu-directory-primary
        positive_ttl_seconds: 300
        negative_ttl_seconds: 60

      binding:
        actor_type: human
        store_ref: participant-bindings

plugins:
  instances:
    feishu-primary:
      type: collaboration-channel.feishu
      enabled: true
      config:
        connector_id: feishu-primary
        identity_admission:
          policy_id: feishu-primary-participants
```

An enabled plugin and policy scope must agree exactly on Work Fabric tenant,
connector, source system and external tenant. A mismatch rejects startup rather
than silently denying all traffic.

The configuration uses an explicit boolean instead of
`external_subject_id: "*"`. The rule means all verified active internal members
of the configured external tenant, not external guests, users from another
tenant, or anybody able to join a shared chat. It applies only to subjects
classified as `human`; Agent and system subjects always require explicit
policy.

Multiple plugin instances may reference different policies. A future database
Provider supplies the same typed policy documents; Admission runtime and
plugins do not depend on YAML or SQL.

## 8. Deterministic evaluation semantics

For a scope-valid request, precedence is fixed and cannot be reordered:

1. exact deny match -> deny;
2. exact allow match -> allow;
3. `all_internal_members` plus fresh `internal + active` evidence -> allow;
4. `all_internal_members` plus fresh external/inactive evidence -> deny;
5. required evidence unavailable or stale beyond policy tolerance -> retryable;
6. no match -> default deny.

An exact deny always overrides exact allow and internal-member allowance. This
supports emergency revocation. Explicit allow does not require a directory
lookup unless a future policy explicitly adds that constraint. The first
version has no implicit allow and no `default: allow`.

Denied decisions are permanent for the claimed policy revision. Evidence or
store outages are retryable and use the existing durable Connector worker's
bounded retry/dead-letter path; outages must not be converted into allow or
permanent deny.

## 9. Participant binding and representation

Every allowed external subject receives its own stable Actor and Endpoint.
Bindings are keyed by:

```text
tenant_id + connector_id + source_system
+ external_tenant_id + external_subject_type + external_subject_fingerprint
```

Creation is atomic and idempotent. Concurrent first messages for one subject
must converge on one binding. Raw external identifiers are not embedded in
Actor IDs. The fingerprint is generated with a tenant-scoped keyed digest so it
cannot be used to correlate subjects across deployments. A connector may keep
the raw identifier only where required for external API calls, under its own
credential and retention controls. Memory is for demos; SQLite and PostgreSQL
provide restart- and cluster-safe identity.

The current Feishu plugin uses one static connector bearer token whose
`ResolvedPrincipal.actor_claims` list contains configured users. That cannot
scale to an unbounded tenant and must not become a wildcard claim.

After an allow decision, `RepresentationGrantIssuer` therefore creates an
opaque, short-lived, single-subject grant bound to:

- Work Fabric tenant and connector;
- external source/tenant subject fingerprint;
- Actor, Actor type and Endpoint;
- Admission decision and policy revision;
- ingress correlation identity, expiry and unique grant ID.

The grant proves trusted representation only. It does not authorize a protocol
operation. `adapter-identity-admission` resolves it to a Principal containing
exactly one Actor claim. A separate Authority adapter still decides the
requested action and resource. The deployment's separate Authority policy
allows the admission-backed connector Principal only the explicit Intake
operation `workfabric.handoff.offer.v1`; it does not grant Accept, result
reporting, verification, administration or arbitrary resource access.

A grant may be retried only for its bound ingress/idempotency identity until
expiry. Reuse for another ingress, connector, Actor or Endpoint is rejected.
Signing/verification keys are deployment credentials with explicit rotation;
neither the grant nor its key is persisted in Admission audit output.

Connector command execution continues through the public TypeScript SDK. The
SDK gains a bounded per-command authentication/representation mechanism or an
equivalent short-lived client facade; it must not bypass HTTP, Identity or
Authority.

## 10. Audit and privacy

Each terminal allow/deny records:

- decision ID, timestamp and stable reason code;
- tenant, connector, source and policy ID/revision;
- a keyed fingerprint of the external subject;
- resulting Actor/Endpoint for allowed decisions;
- evidence provider revision and bounded freshness metadata;
- ingress correlation ID.

It does not record message content, App Secret, access token, raw grant or raw
directory response. Operational views may show a masked external identifier
only to authorized operators. Admission decisions are operational security
facts, not WFPP domain events, and do not become Handoff timeline content.

Denied ingress payload retention remains a Connector storage policy concern.
Deployments should use shorter retention for denied content while retaining the
bounded Admission decision receipt needed for audit.

## 11. Failure, revocation and lifecycle semantics

- Invalid policy, missing referenced Provider or scope mismatch rejects startup.
- Configuration is an immutable process snapshot in the first version.
- Database Providers may later publish new revisions without changing
  Admission consumers.
- Explicit deny can be evaluated without directory availability.
- Internal-member wildcard fails closed when membership cannot be established;
  the durable worker retries rather than silently admitting or discarding.
- A deny update blocks future grants. Existing short-lived grants expire within
  their bound; emergency revocation may additionally revoke grant IDs.
- Inactive or departed members are denied once fresh directory evidence is
  observed.
- A plugin stop does not delete durable bindings or decision records.
- Provider errors expose stable codes and never external payloads or secrets.

## 12. Performance and scalability

- Policy snapshots compile exact allow/deny IDs into immutable hash sets, making
  deterministic matches O(1).
- Deny and explicit allow paths do not call external directories.
- Internal-member evidence uses bounded positive and negative caches with
  policy-defined freshness.
- Binding creation uses a unique composite key and transactional upsert.
- Multi-node deployments share PostgreSQL bindings, decisions and revocations;
  local caches are hints, never authority.
- Admission evaluation is asynchronous after durable ingress, so Feishu's
  callback/long-connection acknowledgement is not held by directory latency.
- Policy/evidence metadata is bounded and does not copy message content.

The layer adds no state or conditional branch to Exchange Core and does not
change Handoff hot-path semantics after Identity and Authority succeed.

## 13. Migration and compatibility

The current Feishu `identities` list combines allowlisting with identity
binding. Migration proceeds in compatibility stages:

1. introduce Admission SPI/runtime and adapt the existing `identities` entries
   into an implicit exact-allow policy;
2. add explicit global policies while rejecting simultaneous ambiguous legacy
   and new configuration;
3. add durable dynamic bindings and representation grants;
4. enable Feishu `all_internal_members` only when its directory evidence
   Provider is configured and healthy;
5. deprecate, then remove the plugin-local list after documented migration.

Webhook and long-connection transports consume the same Admission service.
Changing transport does not change identity or policy semantics.

## 14. Verification strategy

Contract and unit tests must prove:

- default deny and immutable policy snapshots;
- deny > exact allow > internal member > default precedence;
- scope isolation across Work Fabric tenants, connectors and external tenants;
- wildcard never admits external or unknown members;
- evidence outage is retryable and fail-closed;
- bounded cache expiry and revocation behavior;
- one binding under concurrent first admission;
- no shared Actor for distinct external subjects;
- representation grant expiry, connector/tenant binding and single-subject
  claims;
- Admission allow never substitutes for Authority allow;
- configuration, database and future policy adapters pass one conformance suite;
- secrets, message content and raw external directory payloads do not appear in
  logs, decisions, metrics or Console.

End-to-end tests must prove:

- Feishu exact allow creates one Intake Handoff;
- exact deny creates no Handoff even when the user is internal;
- a verified internal wildcard user receives a stable unique Actor binding;
- an external guest in the same chat is denied;
- duplicate events preserve one decision/binding/Handoff;
- directory outage retries through durable ingress and recovers;
- public SDK, Identity and Authority remain on the command path;
- Webhook and long-connection modes produce identical Admission outcomes;
- another synthetic channel adapter reuses the same Admission runtime without
  Feishu imports.

Boundary scanners must reject channel SDK imports in Admission SPI/runtime and
Admission imports in WFPP or Exchange Core.

## 15. Acceptance criteria

The design is successfully implemented when:

- admission is a reusable module outside channel plugins and Exchange Core;
- tenant, bulk allowlist, independent denylist and verified internal-member
  wildcard policies work with fixed precedence;
- every admitted participant has an independently revocable Actor/Endpoint;
- all connector commands still pass through public SDK, Identity and Authority;
- YAML is only one replaceable policy source;
- database-backed policy/binding implementations can be added without changing
  plugin consumers;
- external membership outages fail closed without losing durably accepted
  events;
- the feature does not interpret content, select Agents or execute work;
- automated boundary and end-to-end evidence demonstrates the project position
  remains a collaboration connection and handoff fabric.
