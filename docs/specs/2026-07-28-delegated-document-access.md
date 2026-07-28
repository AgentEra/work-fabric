# Delegated document access

Status: Accepted  
Date: 2026-07-28

## 1. Decision

Document permissions remain authoritative in the connected document system.
Work Fabric carries identity, responsibility and bounded delegation facts; it
does not maintain a second document ACL, a folder allowlist or a document-type
policy.

An Agent may have broad technical connectivity to the document system. That
technical capability is never sufficient authority for a document operation.
Every operation is evaluated on behalf of the represented Actor:

```text
effective authority
  = valid Work Fabric delegation
  ∩ delegated operation scope
  ∩ native document-system permission
  ∩ provider safety requirements
```

The document Provider owns the enforcement point. It must fail closed before a
vendor write when the represented identity cannot be resolved, the delegation
is invalid, or native permission cannot be established.

## 2. Responsibility boundaries

| Component | Closed responsibility |
|---|---|
| Work Fabric | Preserve original initiator, current responsibility, delegation chain, scopes, expiry and audit facts |
| Agent Runtime | Interpret the task and request a declared capability; never mint or select a represented identity |
| Invocation Authority | Derive a narrowed child delegation from canonical Handoff facts |
| Document Access Authorizer | Resolve the represented Actor through an identity broker and obtain a native ACL decision |
| Document Provider | Validate input, call the authorizer, execute with its technical credential, preserve idempotency and return typed facts |
| Document system | Remain the final authority for documents, containers, spaces and their native permissions |
| Usage-side policy/context | Supply default locations, templates and content structure independently of deployment configuration |

Exchange Core, Handoff, Citizen Catalog and the Console must not import
Feishu, Wiki, folder or document-ACL concepts.

## 3. Delegation model

The original Handoff identifies the Human Actor that assigned the work. A
capability invocation may create only a narrowed, non-redelegable child grant.
The child grant contains:

- `delegation_id`;
- `represented_actor_id`;
- `capability_id` and immutable Contract digest;
- operation scopes such as `document:read`, `document:write` or
  `document:delete`;
- expiry no later than the original Handoff deadline;
- the original Handoff and invocation identifiers.

The Agent cannot submit `represented_actor_id`, `delegation_id`, vendor user
IDs or credentials in capability input. Those values are supplied only by the
trusted Invocation Authority and Capability Provider Runtime.

Agent-to-Agent delegation retains the original accountable Human Actor unless
a new independent, verified delegation explicitly changes it.

## 4. Native document authorization port

Document Providers depend on a narrow, replaceable port:

```ts
interface DocumentAccessAuthorizer {
  authorize(input: {
    tenant_id: string;
    represented_actor_id: string;
    delegation_id: string;
    operation: "create" | "read" | "update" | "append" | "delete";
    resource: DocumentResourceReference;
    scopes: readonly string[];
    expires_at: string;
  }): Promise<
    | { decision: "allow"; evidence_ref: string; valid_until: string }
    | { decision: "deny"; reason: string }
  >;
}
```

The implementation may use an on-behalf-of user credential, query native ACL
membership using an identity broker, or call an enterprise authorization
service. Raw user tokens, vendor responses and external subject IDs must not
enter Handoffs, Agent prompts, Results, events, logs or Console projections.

An unavailable identity broker or ACL service is a denial. The Provider must
not fall back to its broad application credential as business authority.
The reference `BrokeredDocumentAccessAuthorizer` keeps the native subject
reference between the identity broker and ACL gateway; neither that reference
nor the native response crosses into Work Fabric.

### 4.1 Development-only app-identity bypass

Local integration may temporarily use the Provider application's technical
identity while the represented-user OAuth and native ACL adapters are not yet
available. This is an explicit deployment adapter, not a change to Work Fabric
authority semantics and not a production authorization mode.

The bypass is enabled only when both controls are present:

1. the Provider service configuration selects
   `development_app_identity`;
2. the process environment explicitly acknowledges the unsafe mode with
   `WORK_FABRIC_ALLOW_UNSAFE_DOCUMENT_ACCESS=true`.

The service must also be in `development_mode`. Startup fails before any
network connection when either guard is missing or when a production service
selects the bypass. The adapter issues short-lived, non-secret evidence bounded
by the original delegation expiry. Delegation validity and operation scopes
remain mandatory, and delete remains subject to the independent confirmation
gate.

The configured default `resource_uri` is placement data only. It does not
become an ACL, allowlist or implicit business authority. Replacing this adapter
with `BrokeredDocumentAccessAuthorizer` must require no Exchange Core, Agent,
Handoff, capability Contract or Feishu backend change.

## 5. Resource and placement model

Public document capability inputs use opaque resource URIs instead of
`folder_token`, `space_id` or a closed document-kind enum:

```json
{
  "resource_uri": "feishu://docx/doc_xxx"
}
```

Creation accepts an optional placement request:

```json
{
  "placement": {
    "resource_uri": "feishu://drive/folder/fld_xxx"
  }
}
```

or:

```json
{
  "placement": {
    "policy_ref": "customer.project.requirements.default"
  }
}
```

`policy_ref` is resolved through a usage-owned `DocumentPlacementResolver`.
It is dynamic policy data, not a deployment ACL. Omitting placement means the
usage-side resolver selects its default; the Provider configuration does not
silently inject a shared folder.

Provider-local adapters translate resource URIs into vendor calls. Adding
Docx, Wiki, Drive, Notion or SharePoint adapters does not change Work Fabric
Core. An unsupported URI fails with a stable `unsupported_resource_type`
result before external mutation.

Templates, headings and content conventions are supplied through context,
Skills or placement policy. They are not embedded in Work Fabric configuration.

## 6. Provider safety

Native ACL authorization is required for create, read, update, append and
delete, including documents previously created by the same Provider. Provider
ownership remains useful for idempotency, revision tracking and conservative
delete cleanup, but never bypasses the represented Actor's permission.

Destructive deletion additionally requires an explicit confirmation proof.
The effective check is therefore:

```text
delegation + native delete permission + confirmation + revision
```

Create checks permission on the resolved container or space. Existing-document
operations check the referenced document. Native ACL is re-evaluated for each
operation; cached decisions must be bounded and may never outlive the
delegation.

## 7. Configuration boundary

Deployment configuration may contain:

- Provider enablement and identity;
- technical credential references;
- endpoint/runtime/storage settings;
- references to identity-broker, native-ACL and placement-resolver
  implementations.

It must not contain:

- mandatory shared-folder tokens;
- document allowlists or denylists;
- per-user document permissions;
- static document-type restrictions;
- templates or customer content structure.

## 8. Compatibility

The existing Feishu document Contract is upgraded because replacing
`{kind, token}` and implicit shared-folder creation changes public input
semantics. Dynamic declarations publish the new major version and immutable
schema digest. Old invocations remain readable from durable state but are not
silently interpreted as the new Contract.

The former shared-folder verifier may remain as an optional deployment
diagnostic adapter, but it is not part of Provider startup and is not an
authorization mechanism.

## 9. Acceptance criteria

- **DA-01** Provider configuration loads without `shared_folder` and rejects
  document ACL/allowlist fields.
- **DA-02** Local startup no longer requires
  `FEISHU_SHARED_FOLDER_TOKEN`.
- **DA-03** public schemas use opaque `resource_uri` and optional dynamic
  placement; they expose no vendor credential or raw token field.
- **DA-04** trusted Invocation Authority, not Agent input, supplies the
  represented Actor and child delegation.
- **DA-05** every document operation calls `DocumentAccessAuthorizer` before
  the backend; denial or outage produces zero vendor mutations.
- **DA-06** Provider ownership never bypasses native authorization.
- **DA-07** create resolves placement dynamically and authorizes the resolved
  container before creation.
- **DA-08** adding a new resource URI adapter requires no Exchange Core,
  Handoff, Catalog or Agent Host change.
- **DA-09** delete still requires native permission, explicit confirmation,
  matching revision and Provider safety constraints.
- **DA-10** secrets, raw external subject IDs and native ACL responses are
  absent from prompts, Handoffs, Results, events, logs and Console data.
- **DA-11** deterministic unit, integration and full-stack tests prove allowed,
  denied, unavailable, idempotent and semantic-reply paths.
- **DA-12** the development app-identity adapter requires development mode,
  an explicit unsafe environment acknowledgement and a matching YAML mode;
  all other combinations fail closed before startup.
- **DA-13** development evidence is short-lived, contains no credential or
  represented-user identifier, and never outlives the Handoff delegation.
- **DA-14** the development default document location is treated only as
  placement; delegation scope, idempotency, revision and confirmation gates
  remain active.

## 10. Implementation status

Implemented on 2026-07-28:

- generic document Provider SPI and brokered authorization boundary;
- Feishu document Contract v2 and resource URI adapter;
- mandatory native ACL enforcement for all document operations;
- narrowed Invocation Authority derived from the accepted original Handoff;
- configurable Feishu intake delegation scopes;
- dynamic placement resolver and removal of mandatory shared-folder startup;
- migrated unit, integration and deterministic full-stack fixtures.

The concrete production identity broker and native ACL gateway remain
deployment adapters. A deployment that does not inject them fails closed.
