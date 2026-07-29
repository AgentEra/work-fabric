# Channel-neutral message content

## Status

Approved in conversation on 2026-07-29.

## Problem

The daily assistant owns its user-facing semantic response and currently returns
that response as text with a media type. Work Fabric transports the Result to
the Feishu Channel, but the Feishu renderer places the response inside a card
`plain_text` element. Markdown syntax is consequently displayed as literal
text; most visibly, `[label](url)` links are not clickable.

This is not a Feishu-only formatting defect. Every collaboration channel has
different native message types, formatting features, size limits and security
rules. Letting an Agent emit Feishu, WeCom, Slack or email-specific syntax
would couple semantic content production to delivery infrastructure. Letting
the Fabric kernel manufacture a replacement response would violate module
ownership.

## Decision

Work Fabric uses the existing `media_type` field as the content representation
discriminator. It does not add a parallel `category` field.

The initial portable representations are:

- `text/markdown`, the default for ordinary Agent-authored rich replies;
- `text/plain`, for deliberately unformatted content.

Future structured interaction formats use registered, versioned vendor media
types, for example
`application/vnd.work-fabric.card+json;version=1`. They are introduced only
when a concrete structured interaction requirement exists.

`message_kind`, `purpose` or business categories such as `approval` are not
introduced in this increment. Content representation and business purpose are
different dimensions and must not be placed in one enum. A separate semantic
purpose may be added later if routing or policy obtains a concrete need for it.

## Responsibility boundary

### Content owner

The Agent or other producing module:

- authors the complete user-facing business meaning;
- emits the correct `media_type`;
- uses portable Markdown rather than channel-private syntax;
- does not select a Feishu message type or construct a Feishu card.

### Work Fabric

The Fabric:

- validates, persists and routes the content representation without changing
  its business meaning;
- retains the `media_type` through the canonical Result and event path;
- does not parse Markdown into Feishu structures;
- does not rewrite, summarize or invent fallback business content.

### Channel

Each Channel:

- declares the media types it can accept and render;
- selects a native presentation for the destination;
- converts the portable representation into channel-native syntax;
- enforces channel limits and safe-link rules;
- reports unsupported or failed conversion explicitly;
- never asks the Agent to emit its private markup.

Channel presentation is an adapter responsibility. It is independent from a
Provider capability that an Agent may explicitly invoke to send an additional
message.

## Content contract

The current text Result part remains:

```ts
interface TextContentPart {
  readonly kind: "text";
  readonly media_type: string;
  readonly text: string;
}
```

The initial recognized values are `text/markdown` and `text/plain`. The open
string surface permits standards-based extension, while every consumer must
match supported media types explicitly. An unknown type must not be silently
treated as Markdown.

The daily assistant emits `text/markdown` by default. It emits `text/plain`
only when formatting is deliberately undesirable or unavailable.

## Channel capability disclosure

A Channel Citizen exposes its accepted media types through its dynamic
capability declaration. The declaration is authoritative for discovery and
negotiation; YAML is only one configuration source and is not the source of
dynamic capability truth.

The first Feishu declaration accepts:

- `text/markdown`;
- `text/plain`.

Structured Work Fabric card media types are not advertised until their
protocol and renderer exist.

## Feishu rendering

For an ordinary assistant reply, the Feishu Channel uses the following mapping:

| Work Fabric representation | Feishu representation |
| --- | --- |
| `text/plain` | `msg_type: text` |
| `text/markdown` | `msg_type: post`, using the native `md` rich-text tag |
| future Work Fabric structured card | `msg_type: interactive` |

The Feishu Open Platform recommends `post` with the `md` tag for Markdown and
documents support for CommonMark 0.31 plus GFM. Interactive cards remain
appropriate for actions, status presentation and structured layouts; they are
not the default wrapper for an ordinary assistant response.

Existing operational Handoff events are unaffected. They remain available
through Fabric events, APIs, SDKs and Console and may continue to use
purpose-built operational rendering outside the assistant conversation reply
route.

References:

- [Feishu message content structures](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/create_json)
- [Feishu send-message API](https://open.feishu.cn/document/server-docs/im-v1/message/create?lang=zh-CN)

## Link handling

The content owner writes portable Markdown links:

```md
[需求文档](https://example.com/requirements/123)
```

The Feishu Channel renderer preserves valid Markdown link syntax in the native
`md` content so Feishu renders a clickable link.

Before delivery, the renderer parses Markdown into tokens and validates every
explicit link destination:

- permit `https`;
- permit `http` only as an explicit channel policy, disabled by default for
  production profiles;
- permit `mailto` when enabled by channel policy;
- reject control characters, malformed URLs and dangerous schemes such as
  `javascript`, `data`, `file` and `vbscript`;
- do not resolve, fetch, expand or follow URLs;
- preserve the Agent-authored label and destination when accepted.

An invalid or forbidden link fails rendering with a stable `unsafe_link`
reason, and the renderer emits a bounded semantic observation. The Channel
must neither activate a dangerous destination nor alter the Agent-authored
message by silently removing it. Observability must not contain message
content or the URL.

Auto-linked bare URLs are left to Feishu's documented Markdown renderer in
this increment. Work Fabric does not invent labels or rewrite bare URLs.

## Negotiation and fallback

The destination Channel first matches the content `media_type`.

- A supported type is rendered natively.
- `text/markdown` may degrade to `text/plain` only through a tested,
  deterministic Markdown-to-text renderer and only when the destination
  declares that fallback policy.
- A structured interaction type must not degrade by dropping actions or
  authority-bearing semantics.
- If no safe rendering exists, delivery fails with a stable
  `unsupported_media_type` or `rendering_failed` reason. The Fabric does not
  synthesize a reply.

The first Feishu implementation supports both initial types directly, so its
normal assistant reply path does not require fallback.

## Limits and failure behavior

Rendering occurs before the outbound OpenAPI call.

- Enforce the Feishu 30 KB request-content limit for `post`.
- Measure the serialized UTF-8 request content, not JavaScript character
  length.
- Reject oversize content with a stable permanent rendering failure in this
  increment; automatic semantic truncation is not allowed because the Channel
  does not own the response meaning.
- Preserve the existing deterministic delivery UUID and retry behavior.
- Treat Feishu API transport and rate-limit failures through the existing
  delivery outcome model.

## Compatibility and migration

The protocol already carries `media_type`, so this increment does not add a
new canonical field.

The existing Feishu `render_mode` setting is retained for operational messages
and backward compatibility. It no longer forces an Agent Result containing
`text/markdown` into a `plain_text` card. Assistant Result rendering is selected
from the content media type:

- Markdown becomes Feishu `post/md`;
- plain text becomes Feishu `text`.

This targeted behavior avoids a broad configuration migration and keeps
content negotiation driven by the producer's declared representation.

## Testing and acceptance

Unit tests must prove:

1. `text/markdown` Result content becomes one Feishu `post` message.
2. `[需求文档](https://example.com/doc)` remains a clickable Markdown link in
   the Feishu-native payload.
3. headings, paragraphs and lists remain in the native Markdown payload.
4. `text/plain` becomes one Feishu `text` message.
5. malformed and dangerous links fail with `unsafe_link` and are not sent.
6. unknown media types fail explicitly rather than being guessed.
7. serialized UTF-8 limits are enforced for both plain and rich messages.
8. Agent-authored meaning is unchanged by the renderer.
9. lifecycle events and operational visibility behavior are unchanged.
10. replay retains the existing deterministic delivery UUID.

Integration tests must prove that one canonical Agent Result produces exactly
one Feishu message with the expected `msg_type` and content structure.

The local real-channel acceptance test sends an assistant prompt whose response
contains a labeled HTTPS link and confirms in Feishu that:

- exactly one semantic reply arrives;
- Markdown source markers are not shown as literal formatting syntax;
- the link label is visible and clickable;
- opening the link uses the Agent-authored destination.
