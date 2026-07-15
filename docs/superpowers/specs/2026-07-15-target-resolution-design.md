# Work Fabric Target Resolution Design

## 1. Goal

Target Resolution lets an external human, rule service, or Agent Brain turn an
unresolved `CapabilityRequirement` into one explicit Actor or Endpoint target.
It preserves the full handoff audit chain without moving matching, ranking,
recommendation, or execution planning into Work Fabric.

This design is a prerequisite for exposing Capability-targeted Handoffs through
the Phase 3 HTTP and TypeScript SDK Binding. Direct Actor and Endpoint targets
continue to work without a Resolver.

## 2. Boundary

Work Fabric owns:

- recording the immutable Capability Requirement;
- exposing a pending-resolution state and public event;
- authenticating and authorizing the Resolver command;
- validating that the proposed target is explicit and eligible;
- recording the Target Binding, provenance, evidence, and authoritative order;
- moving the Handoff into `offered` only after a valid binding exists;
- reliably dispatching the resulting Offer through a compatible Binding.

Work Fabric does not own:

- candidate matching, ranking, scoring, recommendation, or optimization;
- deciding which model, tool, worker, or execution plan the recipient uses;
- treating first response, random choice, or concurrent write order as a
  scheduling policy;
- silently falling back to another target after a resolution fails or a
  recipient declines.

Candidate facts can come from the later Endpoint Directory or another
authorized external source. A Resolver remains an optional protocol client and
must be replaceable or removable.

## 3. Chosen approach

Target Resolution is a two-stage binding inside the same Handoff aggregate.

1. An Offer with an Actor or Endpoint target follows the existing path and
   enters `offered` immediately.
2. An Offer with a Capability Requirement creates the Handoff in
   `target_resolution_pending` and emits a resolution-requested event.
3. An authorized external Resolver submits one explicit Actor or Endpoint.
4. Exchange validates and records one immutable Target Binding, transitions the
   Handoff to `offered`, and emits a target-resolved event.
5. Handoff Dispatch can then deliver the Offer. Delivery still does not mean
   responsibility acceptance.

The original `HandoffPackage.target.capability_requirement` never changes. The
resolved target is stored separately, so audit consumers can see both the
requested capability and the selected participant.

### Rejected alternatives

**Resolve before creating a Handoff** is simpler but loses the authoritative
link between the original Capability Requirement and the final target.

**Create a separate Target Resolution aggregate** gives maximum separation but
adds another public resource, lifecycle, transaction boundary, and correlation
model before the first production Binding needs them.

## 4. Lifecycle

The Handoff lifecycle gains two states:

- `target_resolution_pending`: non-terminal; no recipient owns responsibility
  and no Offer may be dispatched;
- `target_unavailable`: terminal; an authorized Resolver reported that it could
  not produce an eligible target for this Handoff.

The initial state depends on target kind:

| Target in Offer | Initial state | Initial public event |
|---|---|---|
| Actor | `offered` | `workfabric.handoff.offered.v1` |
| Endpoint | `offered` | `workfabric.handoff.offered.v1` |
| Capability Requirement | `target_resolution_pending` | `workfabric.handoff.target_resolution_requested.v1` |

Allowed resolution transitions are:

| Interaction | From | To | Public event |
|---|---|---|---|
| `handoff.resolve_target` | `target_resolution_pending` | `offered` | `workfabric.handoff.target_resolved.v1` |
| `handoff.report_target_unavailable` | `target_resolution_pending` | `target_unavailable` | `workfabric.handoff.target_unavailable.v1` |
| `handoff.cancel` | `target_resolution_pending` | `cancelled` | `workfabric.handoff.cancelled.v1` |
| `handoff.expire` | `target_resolution_pending` | `expired` | `workfabric.handoff.expired.v1` |

`accept_by` remains the single deadline for obtaining a target and receiving
acceptance in the first profile. This deliberately avoids a second deadline
policy. If resolution consumes too much of the acceptance window, the
initiator cancels or creates a new Handoff with a later deadline.

`accept`, `decline`, status, result, verification, rework, close, and transfer
are invalid while resolution is pending. Once `target_unavailable` is recorded,
the initiator must create a new Handoff rather than mutate history.

Transfer applies the same target-dependent initial rule to its atomically
created child Handoff. An explicit child target starts `offered`; a Capability
child target starts `target_resolution_pending`. The parent remains `accepted`
and the current recipient remains responsible until the child later accepts.

## 5. Protocol interactions

### 5.1 Resolve Target

The public message type is:

```text
workfabric.handoff.resolve_target.v1
```

Its payload Schema is `urn:work-fabric:schema:v1:handoff-target-resolution` and
contains:

```json
{
  "handoff_id": "hf_123",
  "resolved_target": {
    "endpoint_id": "endpoint_456"
  },
  "evidence": []
}
```

`resolved_target` accepts exactly one `actor_id` or `endpoint_id`; a nested
Capability Requirement is forbidden. `evidence` uses the existing Evidence
Schema and is optional with an empty-array default at the SDK boundary.

The Resolver identity and provenance come from the authenticated Command
Envelope: `actor_id`, `endpoint_id`, optional `delegation_id`, `message_id`,
`correlation_id`, `causation_id`, and `sent_at`. Clients must not duplicate or
override those trusted fields inside the payload.

### 5.2 Report Target Unavailable

The public message type is:

```text
workfabric.handoff.report_target_unavailable.v1
```

Its payload Schema is
`urn:work-fabric:schema:v1:handoff-target-unavailable-command` and contains:

```json
{
  "handoff_id": "hf_123",
  "reason_code": "no_eligible_target",
  "reason": [
    {
      "kind": "text",
      "media_type": "text/plain",
      "text": "No authorized endpoint currently satisfies the requirement"
    }
  ],
  "evidence": []
}
```

`reason_code` is one of `no_candidate`, `no_eligible_target`,
`policy_rejected`, or `resolver_unavailable`. This reports a Resolver outcome;
it is not a protocol error and does not imply the Exchange ran a selection
algorithm.

### 5.3 Operation results

A successful Resolve Target returns the normal Handoff resource reference at
the new resource version. A successful unavailable report does the same with a
snapshot whose lifecycle is `target_unavailable`.

Stable errors use existing protocol categories:

- `invalid_argument` for a Capability Requirement used as `resolved_target`;
- `invalid_state` when the Handoff is no longer pending;
- `permission_denied` when the Resolver lacks authority;
- `not_found` for an unknown Handoff;
- `version_conflict` for stale `expected_version`;
- `temporarily_unavailable` when eligibility cannot be verified safely.

## 6. Authoritative state and events

`HandoffState` gains a nullable Target Binding:

```text
TargetBinding
  target                 Actor or Endpoint only
  resolved_by            authenticated ActorRef
  resolver_endpoint_id   authenticated Endpoint ID
  delegation_id          optional delegated authority
  resolved_at            authoritative command time
  evidence               immutable Evidence references
```

For a direct target, `target_binding` remains null and the effective target is
the package target. For a Capability target, the effective target is null while
pending and becomes `target_binding.target` after resolution.

The resolution-requested domain event contains the data currently carried by
the offered event: Handoff ID, Thread ID, initiator, immutable Package, parent
Handoff ID, and occurrence time. This lets replay create the aggregate without
inventing a mutable draft.

The target-resolved event contains the immutable Target Binding. The
target-unavailable event contains the Resolver provenance, reason code, reason,
and evidence. Public Protocol Events expose safe summaries and references; they
must not leak candidate lists, private scores, policy internals, credentials,
or full sensitive Context.

## 7. Validation and authorization

Resolution requires all of the following:

1. the Handoff exists and is `target_resolution_pending`;
2. the original package target is a Capability Requirement;
3. the proposed target is exactly one Actor or Endpoint;
4. identity, tenant, Exchange, delegation, and `resolve_target` authority pass;
5. a `TargetEligibilityVerifier` confirms that the proposed target satisfies
   the immutable requirement under the current authorized facts;
6. the expected Handoff version still matches.

`TargetEligibilityVerifier` is a technology-neutral Exchange SPI. It receives
one requirement and one proposed explicit target and returns only
`eligible`, `ineligible`, or `unavailable`. It cannot return candidates, ranks,
recommendations, or a replacement target. The later Endpoint Directory can
implement this SPI; Phase 3 must fail closed with `temporarily_unavailable` if
no verifier is configured.

`report_target_unavailable` requires Resolver authority but does not call the
eligibility verifier because it does not bind a participant.

Concurrent resolution commands use the existing expected-version and atomic
commit rules. At most one binding becomes authoritative. A losing write gets
`version_conflict`; this is a storage invariant, not “first valid Resolver
wins” product policy.

## 8. Dispatch and acceptance

Handoff Dispatch consumes only the effective explicit target. It must never
dispatch `target_resolution_pending` or `target_unavailable` Handoffs.

For an Actor target, the recipient must authenticate as that Actor. For an
Endpoint target, the accepting Actor must be authorized to act through that
Endpoint. A successful delivery, Webhook 2xx, SSE read, Cursor Pull, or Delivery
Ack does not change Handoff responsibility. Only `handoff.accept` does.

If a resolved recipient declines, the Handoff follows the existing terminal
`declined` transition. Work Fabric does not silently re-resolve; a new Handoff
is required so the next decision remains explicit and auditable.

## 9. Phase boundaries

### Phase 3: HTTP and TypeScript SDK Binding

Phase 3 implements the protocol Schemas, lifecycle artifacts, Exchange Core
transitions, `TargetEligibilityVerifier` SPI, generic HTTP Command carriage,
and TypeScript SDK methods for both resolution outcomes. Capability-targeted
HTTP offers are enabled only when a verifier is configured; otherwise the
service fails closed instead of accepting an unresolvable public workflow.

### Phase 4: Endpoint and Agent participation

Phase 4 implements Endpoint registration, capability discovery, leases, and an
Endpoint Directory-backed eligibility verifier. Human, rule, and Agent Brain
Resolvers can then query authorized facts and submit the same Phase 3 commands.

Neither phase adds candidate ranking or execution scheduling to Exchange Core.

## 10. Testing and acceptance

The protocol and Core work is accepted when tests prove:

- direct Actor and Endpoint Offers still enter `offered` unchanged;
- Capability Offers enter `target_resolution_pending` and cannot dispatch or
  accept;
- one authorized, eligible explicit target moves the Handoff to `offered` and
  preserves the original Capability Requirement;
- an unavailable report reaches the transparent terminal state;
- an unauthorized, ineligible, nested-Capability, stale, or duplicate
  resolution cannot create a Target Binding;
- concurrent resolutions commit at most one authoritative binding;
- replay, snapshots, public events, PostgreSQL persistence, projections, and
  subscriptions understand the new states and events;
- direct-target deployments work without any Resolver;
- Core and SPI retain their transport and concrete-technology dependency
  guards.

The HTTP and SDK work is accepted when the same successful and failing flows
round-trip through the public Binding without introducing transport-specific
domain behavior.
