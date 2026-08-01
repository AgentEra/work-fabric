# Temporary Debug-to-Feishu Delivery Design

## Goal

Run one bounded local experiment in which Debug Channel simulates the inbound
Feishu message, the real Daily Assistant Agent authors the semantic Result,
and the existing Feishu Channel sends that Result through the real Feishu
OpenAPI to the most recently used test group.

## Boundaries

- Do not modify Exchange Core, protocol schemas, Channel SPIs, Agent Runtime,
  the canonical local Feishu bundle, or persistent project configuration.
- Do not make Debug Channel depend on Feishu.
- Generate one temporary resolved configuration outside the repository.
- Enable both existing Channel plugins in the same service composition.
- Add one temporary Feishu static channel and Result subscription for the
  confirmed test chat.
- Keep the normal Debug capture route for correlation and diagnostics; it is
  not the user-visible destination.
- Use the existing environment secret file without printing or copying secret
  values into logs or repository files.
- Stop all processes and remove the temporary configuration after the test.

## Flow

```text
temporary Debug HTTP
  -> Connector Ingress
  -> Handoff
  -> Daily Assistant Agent
  -> canonical text/markdown Result
  -> Signal Dispatcher
     -> Debug Capture (diagnostic)
     -> Feishu static subscription
        -> Feishu Channel renderer
        -> native post/md payload
        -> real Feishu OpenAPI
        -> confirmed test group
```

## Acceptance

1. The Debug submission reaches one completed Ingress and one Handoff.
2. The Agent returns one semantic `text/markdown` Result containing an HTTPS
   Markdown link.
3. Debug Capture retains the same media type and content.
4. The Feishu adapter reports successful real delivery without fabricated
   OpenAPI responses.
5. The user sees one native Feishu message in the confirmed test group and can
   click the link.
6. The temporary subscription, processes and generated configuration are
   removed after observation.

## Failure handling

If identity, Authority, Agent, Signal or Feishu OpenAPI fails, report the owning
layer and stable state. Do not bypass the failed layer, synthesize a reply, or
retry with a different chat. Never expose credentials or raw vendor responses.
