# Agent-owned conversation replies

## Status

Approved in conversation on 2026-07-27.

## Problem

The Feishu channel currently renders every Handoff lifecycle and progress event
as a new card. The renderer derives user-visible text from Fabric snapshots, so
several different events appear as repeated `accepted` messages containing
internal Handoff identifiers.

The daily assistant model also produced a useful response while omitting an
optional handoff-draft field. The worker validator required every schema field,
rejected the response, and therefore never returned a protocol Result.

## Boundary

The daily assistant Agent owns all user-facing semantic reply content for its
conversation. Work Fabric does not author, summarize, translate, or otherwise
manufacture that content.

- The Agent produces the semantic response in its Runtime Result.
- The Agent Runtime validates and transports that response without changing its
  meaning.
- Work Fabric persists and routes canonical lifecycle, status, and Result
  events.
- The Feishu Adapter maps Agent-owned content to Feishu message syntax and
  delivers it. It does not compose business replies from Handoff state.
- Operational lifecycle and progress remain visible through the event stream,
  APIs, SDK, and Console. They are not sent as assistant chat replies.

This keeps the Fabric kernel independent of Agent roles and keeps the Agent
independent of Feishu.

The rule is project-wide rather than Feishu-specific: every module must close
its own responsibility and exchange facts only through a stable protocol or
SPI. A module may validate, transport, or present a fact owned by another
module, but it may not manufacture that module's business semantics, decision,
or execution. Concrete storage, Runtime, provider, and channel implementations
must remain behind composition-time adapters.

## Result contract

The assistant output contract distinguishes required semantic fields from
conditional handoff-draft fields.

- `request_summary`, `response`, `missing_information`,
  `handoff_draft_required`, and `handoff_draft_reason` are required.
- When `handoff_draft_required` is false, omitted draft capability, intent, and
  acceptance criteria normalize to empty values.
- When `handoff_draft_required` is true, capability, intent, and at least one
  acceptance criterion remain required and are validated.
- Unknown fields remain invalid.

The worker places the Agent-owned `response` in the first text entry of the
Runtime Result `summary`. That summary is the sole source for the Feishu
conversation reply.

## Outbound channel policy

The route that returns a Feishu-originated Handoff to its original conversation
delivers only a canonical `workfabric.handoff.result_returned.v1` event as an
assistant reply.

Offered, accepted, declined, cancelled, expired, transferred, status, and
verification events remain canonical Fabric events but do not create assistant
chat messages on this route. Other subscriptions and operational consumers are
unchanged.

The Feishu Result renderer extracts text summary entries from the canonical
Result payload and emits text or card content according to the destination
render mode. Internal Handoff IDs and lifecycle values are excluded from the
primary content.

## Failure behavior

Transport and model failures do not authorize Fabric or the Feishu Adapter to
invent an Agent reply. They remain observable as Runtime state and Fabric
status events. A future Agent-owned failure response may be added to the Agent
Runtime result contract, but it must still originate from that role boundary.

## Testing

- Python unit tests prove omitted conditional draft fields normalize correctly
  and remain required when a downstream draft is requested.
- Feishu renderer tests prove Result events render only Agent-owned summary
  text.
- Route tests prove progress and lifecycle events are not returned to the
  originating conversation while Result events are.
- Existing connector, plugin, runtime, and full verification suites guard the
  protocol and adapter boundaries.
- A local end-to-end test sends a Feishu message, observes a successful Runtime
  Result, and confirms exactly one semantic assistant reply.
