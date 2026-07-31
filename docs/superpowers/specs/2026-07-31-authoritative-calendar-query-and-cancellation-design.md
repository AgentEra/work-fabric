# Authoritative Calendar Query and Cancellation Design

**Status:** Implemented and verified
**Date:** 2026-07-31  
**Scope:** Feishu Calendar event facts and Daily Assistant scheduling-session cancellation

## 1. Problem

Two failures currently share one visible conversation but have different owners:

1. When a Human asks for recent or upcoming events, the Daily Assistant has no
   authoritative event-list capability. It therefore treats an old
   `awaiting_confirmation` proposal as if it were calendar data.
2. When a Human cancels that proposal, the model can write a friendly
   cancellation reply while returning no private-state mutation. The reply is
   delivered, but the Agent-owned session remains active and contaminates
   later turns.

The fix must not move scheduling semantics into Work Fabric or the Feishu
Channel.

## 2. Boundaries

| Owner | Must close within the owner | Must not do |
| --- | --- | --- |
| Calendar Provider | Resolve an authorized Feishu user primary calendar, query a bounded time window, page results, normalize visibility and return typed facts | Interpret “我的日程”, compose a user reply or read Agent private state |
| Daily Assistant | Decide whether the current intent requires a calendar query, select the current sender as the represented subject, explain returned visibility, and atomically persist cancellation before replying. Its application-specific Driver handles an unambiguous original-initiator cancellation deterministically; ambiguous language remains an Agent decision | Call Feishu directly, invent hidden event details or use a proposal as calendar truth |
| Generic Agent Runtime | Carry the task, run capability continuation, and persist validated Runtime records | Interpret scheduling semantics or synthesize business replies |
| Feishu Channel | Carry trusted sender/conversation facts and render the Agent-authored Result | Query calendars, cancel sessions or author fallback business text |
| Work Fabric | Carry Capability Handoffs, Authority, result facts and audit state | Orchestrate the calendar flow or inspect private scheduling state |

## 3. Calendar query contract

The Calendar Provider declares a new read-only capability:

```text
feishu.calendar.events.list
```

Input:

```json
{
  "subject_resource_uri": "feishu://user/open-id/ou_xxx",
  "start_at": "2026-07-31T00:00:00+08:00",
  "end_at": "2026-08-03T00:00:00+08:00",
  "page_size": 50,
  "page_token": "optional opaque provider token"
}
```

Rules:

- the subject must be present in the invocation Authority
  `allowed_target_refs`;
- the interval must be increasing and no longer than 31 days;
- `page_size` is between 1 and 50;
- the Provider uses Feishu application identity plus `op_user_id` to resolve
  the subject's primary calendar and query that calendar;
- the Provider never registers the Human primary calendar as a managed
  writable binding and never stores its events as Provider-owned assets;
- a page token is opaque and bounded.

Output contains:

- subject and primary-calendar resource references;
- the requested coverage;
- `access_mode`: `full`, `free_busy_only`, or `unknown`;
- normalized event facts with date-time or all-day boundaries;
- optional title, URL and organizer facts only when Feishu returns them;
- `details_visible` on every item;
- `has_more` and optional `next_page_token`; and
- Feishu provenance.

An event with no visible title is still an authoritative busy event. The
Provider returns it with `details_visible=false`; it does not invent a title.

## 4. Live Feishu constraint

A 2026-07-31 read-only probe with the configured application identity proved:

- batch primary-calendar resolution returns the message sender's primary
  calendar;
- the application currently has `free_busy_reader`;
- a bounded event-list call succeeds and returned eleven event intervals; and
- none of the eleven titles were visible.

The implementation therefore supports the currently usable free/busy-shaped
event facts while keeping the same contract ready for full details when the
deployment later supplies a user identity or stronger calendar access.

## 5. Daily Assistant behavior

For a current intent asking what events a Human has in a time window, the
Agent must request `feishu.calendar.events.list` for
`agent_private_context.current_source.sender_resource_uri`.

The Agent must:

- use Provider results as the only calendar truth;
- distinguish a pending proposal from a created event;
- describe redacted events as busy time slots, not named events;
- disclose when event titles are unavailable because of calendar visibility;
- request another page only when `has_more=true` and the missing page is
  material to the current question; and
- never repeat an inactive or cancelled proposal as a current calendar event.

## 6. Cancellation state contract

When an active session is `awaiting_confirmation` and the original initiator's
current message means “cancel this proposal”, the final Agent turn must carry:

```json
{
  "namespace": "daily-assistant.scheduling/v1",
  "expected_version": 1,
  "phase": "cancelled",
  "proposal": null,
  "confirmed_proposal_digest": null,
  "confirmation_handoff_id": null,
  "calendar_result_uri": null,
  "capability_result_handoff_ids": []
}
```

The Runtime adapter applies the mutation before returning the final Result. If
optimistic persistence fails, the cancellation reply is not returned as a
successful final turn.

For a clear cancellation command from the original initiator, the
Daily Assistant's own application Driver performs this transition
deterministically instead of depending on a model to reproduce the state
envelope. This is still Agent-owned behavior: neither Fabric, Channel nor
Calendar Provider recognizes the business intent.

Repository validation requires:

- an active session exists;
- it is still `awaiting_confirmation`;
- the current actor and sender are the original initiator;
- no confirmation, event URI or capability-result references are supplied;
- no Calendar delete call is made, because the proposal has not created an
  external event; and
- a terminal `cancelled` record is excluded from future `active_session`
  context.

Cancellation of an already-created event remains a separate destructive
Calendar capability and is not covered by this proposal-cancellation path.

## 7. Failure behavior

- Unauthorized subject: `target_not_allowed`.
- Missing primary calendar: `calendar_not_found`.
- Feishu permission denial: `feishu_permission_denied`.
- Malformed/redacted provider response: fail closed as
  `feishu_response_invalid`; do not let the Agent infer missing fields.
- Concurrent private-state change: fail the turn; do not emit a false
  cancellation acknowledgment.
- Provider query failure: the Agent reports the failure and does not fall back
  to private proposal state.
- A newly declared capability must have a matching least-privilege
  `workfabric.citizen.declaration.read.v1` rule for the consuming Agent.
  Otherwise progressive disclosure fails before the Agent turn.
- When the Provider capability set changes, local provisioning advances the
  Endpoint registration version and starts the Provider Runtime with that
  exact negotiated version. It never overwrites a changed declaration set at
  the same optimistic version.

## 8. Acceptance criteria

1. Calendar Provider declares, validates, authorizes and executes
   `feishu.calendar.events.list`.
2. The OpenAPI adapter resolves the requested primary calendar and returns
   bounded, paged facts including redacted items and all-day events.
3. Local invocation Authority permits only the trusted current Feishu sender
   as the query subject.
4. The Daily Assistant prompt explicitly requires the new capability for
   authoritative event questions and forbids proposal substitution.
5. A cancellation final turn persists `phase=cancelled` before its reply is
   returned.
6. The next turn sees `active_session=null`.
7. Existing creation, confirmation, document, message and Fabric tests remain
   green.
8. A real opt-in smoke query with the configured Feishu application returns
   actual event intervals without exposing credentials or inventing titles.
9. Re-running the local stack over an existing v1 Provider registration
   migrates it to v2 and keeps the Runtime session version aligned.
10. The real Feishu-routed cancellation and subsequent three-day query both
    reach `result_returned`; private scheduling state is `cancelled`, and the
    query invokes `feishu.calendar.events.list`.
