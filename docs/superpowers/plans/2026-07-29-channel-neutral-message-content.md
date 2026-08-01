# Channel-neutral Message Content Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve Agent-authored `media_type`, render Markdown assistant replies as native clickable Feishu rich text, and reject unsafe links without coupling the Agent or Fabric kernel to Feishu.

**Architecture:** The canonical Result remains unchanged and carries text plus `media_type`. A focused Markdown safety module validates link tokens, while `FeishuEventRenderer` performs content negotiation and maps `text/plain` to Feishu `text` and `text/markdown` to Feishu `post/md`; the OpenAPI client transports all three supported native types (`text`, `post`, `interactive`). Runtime adapter manifests disclose the portable media types they render.

**Tech Stack:** TypeScript 7, Node.js 22, Vitest 4, `marked` 18.0.7, Feishu IM v1 OpenAPI.

## Global Constraints

- `text/markdown` is the default portable rich representation; `text/plain` remains supported.
- The Agent owns all user-facing business meaning; Fabric and Channels must not author or summarize it.
- The Fabric kernel must remain channel-neutral and must not import Feishu or Markdown rendering code.
- Feishu Markdown replies use `msg_type: post` with the native `md` tag.
- Explicit links permit `https`; `http` and `mailto` remain disabled in this increment.
- Dangerous or invalid parsed link destinations fail with `unsafe_link`; message content and URLs never enter observations.
- Unknown media types fail explicitly and are never guessed as Markdown.
- Serialized UTF-8 limits are 150,000 bytes for `text` and 30,000 bytes for `post` and `interactive`.
- Structured interaction media types are outside this increment.
- Existing operational Handoff rendering, delivery UUIDs and retry behavior remain unchanged.

---

### Task 1: Portable Markdown Link Safety

**Files:**
- Create: `packages/connector-feishu/src/markdown-content.ts`
- Modify: `packages/connector-feishu/src/index.ts`
- Modify: `packages/connector-feishu/package.json`
- Modify: `package-lock.json`
- Test: `packages/connector-feishu/test/markdown-content.test.ts`

**Interfaces:**
- Consumes: Markdown strings owned by upstream content producers.
- Produces: `assertSafeMarkdownLinks(markdown: string): void` and `FeishuMarkdownError` with stable code `"unsafe_link"`.

- [ ] **Step 1: Add `marked` as an exact workspace dependency**

Run:

```bash
npm_config_cache=/tmp/work-fabric-npm-cache npm install --workspace @work-fabric/connector-feishu --save-exact marked@18.0.7
```

Expected: `packages/connector-feishu/package.json` contains `"marked": "18.0.7"` and `package-lock.json` records the resolved package.

- [ ] **Step 2: Write failing Markdown safety tests**

Create tests covering nested Markdown tokens, HTTPS, relative/invalid destinations and dangerous schemes:

```ts
import { describe, expect, it } from "vitest";
import {
  assertSafeMarkdownLinks,
  FeishuMarkdownError,
} from "../src/index.js";

describe("assertSafeMarkdownLinks", () => {
  it("accepts portable HTTPS links nested in Markdown", () => {
    expect(() => assertSafeMarkdownLinks(
      "## 结果\n\n- [需求文档](https://example.com/r/1?from=agent)",
    )).not.toThrow();
  });

  it.each([
    "[危险](javascript:alert(1))",
    "[本地](file:///etc/passwd)",
    "[数据](data:text/html;base64,WA==)",
    "[相对](../private)",
    "[无协议](example.com/doc)",
  ])("rejects an unsafe or invalid parsed destination: %s", (markdown) => {
    expect(() => assertSafeMarkdownLinks(markdown)).toThrow(
      expect.objectContaining<Partial<FeishuMarkdownError>>({
        code: "unsafe_link",
      }),
    );
  });

  it("does not fetch or rewrite a safe link", () => {
    const markdown = "[文档](https://example.com/a_(b))";
    expect(() => assertSafeMarkdownLinks(markdown)).not.toThrow();
  });
});
```

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
npx vitest run packages/connector-feishu/test/markdown-content.test.ts
```

Expected: FAIL because the exported safety API does not exist.

- [ ] **Step 4: Implement token-based validation**

Create `markdown-content.ts` using `marked.lexer` plus `walkTokens`. Validate every parsed `link` token with `new URL(token.href)`, require protocol `https:`, and reject control characters before URL parsing:

```ts
import { lexer, walkTokens, type Token } from "marked";

export class FeishuMarkdownError extends Error {
  readonly code = "unsafe_link" as const;
  constructor() {
    super("unsafe_link");
    this.name = "FeishuMarkdownError";
  }
}

function assertSafeHref(href: string): void {
  if (/[\u0000-\u001f\u007f]/u.test(href)) throw new FeishuMarkdownError();
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    throw new FeishuMarkdownError();
  }
  if (parsed.protocol !== "https:") throw new FeishuMarkdownError();
}

export function assertSafeMarkdownLinks(markdown: string): void {
  const tokens = lexer(markdown, { gfm: true });
  walkTokens(tokens, (token: Token) => {
    if (token.type === "link") assertSafeHref(token.href);
  });
}
```

Give the error a fixed non-content message and export the module from `src/index.ts`. Do not log or retain the rejected href.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
npx vitest run packages/connector-feishu/test/markdown-content.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit the safety boundary**

```bash
git add package.json package-lock.json packages/connector-feishu/package.json packages/connector-feishu/src/markdown-content.ts packages/connector-feishu/src/index.ts packages/connector-feishu/test/markdown-content.test.ts
git commit -m "feat(feishu): validate portable markdown links"
```

### Task 2: Media-aware Feishu Result Rendering

**Files:**
- Modify: `packages/connector-feishu/src/event-renderer.ts`
- Modify: `packages/connector-feishu/src/signal-adapter.ts`
- Test: `packages/connector-feishu/test/signal-adapter.test.ts`

**Interfaces:**
- Consumes: canonical Result summary parts `{ kind: "text"; media_type: string; text: string }`.
- Produces: `FeishuRenderedMessage` with native `msg_type: "text" | "post" | "interactive"` and stable render failure codes.
- Uses: `assertSafeMarkdownLinks(markdown: string): void` from Task 1.

- [ ] **Step 1: Replace the existing broad Result test with explicit failing media tests**

Add one Markdown Result fixture:

```ts
const markdownResultEvent: ProtocolEvent = {
  ...agentResultEvent,
  id: "event-agent-markdown-result",
  data: {
    ...agentResultEvent.data,
    snapshot: {
      ...(agentResultEvent.data.snapshot as Record<string, unknown>),
      result: {
        summary: [{
          kind: "text",
          media_type: "text/markdown",
          text: "## 已完成\n\n请查看[需求文档](https://example.com/doc)。",
        }],
        artifacts: [],
        evidence: [],
        extensions: {},
      },
    },
  },
};
```

Assert:

```ts
expect(messages.inputs[0]).toMatchObject({ msg_type: "post" });
expect(JSON.parse(messages.inputs[0]!.content)).toEqual({
  zh_cn: {
    title: "",
    content: [[{
      tag: "md",
      text: "## 已完成\n\n请查看[需求文档](https://example.com/doc)。",
    }]],
  },
});
```

Also assert `text/plain` produces `msg_type: "text"` regardless of destination `render_mode`, an unknown media type returns `{ kind: "permanent_failure", detail: "unsupported_media_type" }`, and a dangerous link returns `{ kind: "permanent_failure", detail: "unsafe_link" }` without calling the message client.

- [ ] **Step 2: Run the Result rendering tests and verify RED**

Run:

```bash
npx vitest run packages/connector-feishu/test/signal-adapter.test.ts
```

Expected: FAIL because Markdown still renders as `interactive/plain_text`.

- [ ] **Step 3: Preserve Result media type**

Replace `agentResultText` with:

```ts
interface AgentResultContent {
  readonly media_type: string;
  readonly text: string;
}

function agentResultContent(event: ProtocolEvent): AgentResultContent {
  // retain current safe-object and summary validation
  // require exactly one coherent supported text representation in this increment
}
```

Do not infer Markdown from text syntax. Join multiple text parts only when their
`media_type` values match; reject mixed types as `unsupported_media_type`.

- [ ] **Step 4: Add stable rendering errors**

Add:

```ts
export class FeishuRenderError extends Error {
  constructor(
    readonly code:
      | "unsupported_media_type"
      | "unsafe_link"
      | "rendering_failed",
  ) {
    super(code);
  }
}
```

Map `FeishuMarkdownError` to `FeishuRenderError("unsafe_link")`. Update
`FeishuSignalAdapter.deliver` to return the render error code as a permanent
failure while preserving the existing destination-validation and retryable
transport classifications.

- [ ] **Step 5: Render portable text natively**

For `text/plain`, serialize:

```ts
JSON.stringify({ text: content.text })
```

For `text/markdown`, validate links and serialize:

```ts
JSON.stringify({
  zh_cn: {
    title: "",
    content: [[{ tag: "md", text: content.text }]],
  },
})
```

Return `msg_type: "post"` for Markdown. Use `max_text_bytes` for text and
`max_card_bytes` for post and interactive, measuring serialized UTF-8 bytes.
Leave non-Result operational rendering and action cards unchanged.

- [ ] **Step 6: Run focused connector tests**

Run:

```bash
npx vitest run packages/connector-feishu/test/markdown-content.test.ts packages/connector-feishu/test/signal-adapter.test.ts
```

Expected: PASS, including existing stable UUID and operational card tests.

- [ ] **Step 7: Commit media-aware rendering**

```bash
git add packages/connector-feishu/src/event-renderer.ts packages/connector-feishu/src/signal-adapter.ts packages/connector-feishu/test/signal-adapter.test.ts
git commit -m "feat(feishu): render agent markdown as rich text"
```

### Task 3: Feishu OpenAPI Transport and Capability Disclosure

**Files:**
- Modify: `packages/connector-feishu/src/open-api-client.ts`
- Modify: `packages/exchange-spi/src/signal.ts`
- Modify: `packages/connector-feishu/src/signal-adapter.ts`
- Modify: `packages/plugin-channel-feishu/src/route-aware-signal-adapter.ts`
- Test: `packages/connector-feishu/test/open-api-client.test.ts`
- Test: `packages/connector-feishu/test/signal-adapter.test.ts`
- Test: `packages/plugin-channel-feishu/test/route-aware-signal-adapter.test.ts`

**Interfaces:**
- Consumes: `FeishuSendMessageInput.msg_type`.
- Produces: transport support for `"post"` and manifest flags from `signalMediaTypeCapability(mediaType: string): string`.

- [ ] **Step 1: Write failing OpenAPI and manifest tests**

Add a client test that sends:

```ts
{
  ...message,
  msg_type: "post",
  content: JSON.stringify({
    zh_cn: { title: "", content: [[{ tag: "md", text: "[文档](https://example.com)" }]] },
  }),
}
```

Assert the request body retains `msg_type: "post"`. Add tests that both the
direct Feishu adapter and route-aware Channel adapter manifests contain:

```ts
{
  [signalMediaTypeCapability("text/plain")]: true,
  [signalMediaTypeCapability("text/markdown")]: true,
}
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npx vitest run packages/connector-feishu/test/open-api-client.test.ts packages/connector-feishu/test/signal-adapter.test.ts packages/plugin-channel-feishu/test/route-aware-signal-adapter.test.ts
```

Expected: FAIL because `post` and media capability keys are unsupported.

- [ ] **Step 3: Add the generic media capability key helper**

In `packages/exchange-spi/src/signal.ts`, add:

```ts
export function signalMediaTypeCapability(mediaType: string): string {
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mediaType)) {
    throw new TypeError("media_type is invalid");
  }
  return `media_type:${mediaType.toLowerCase()}`;
}
```

Use this helper rather than Feishu-specific capability names.

- [ ] **Step 4: Extend the OpenAPI boundary**

Change:

```ts
readonly msg_type: "text" | "post" | "interactive";
```

Accept all three values in `validateMessage`. Apply 150,000 bytes only to
`text`; apply 30,000 bytes to `post` and `interactive`. Preserve the existing
request body, token refresh and outcome classification logic.

- [ ] **Step 5: Disclose supported portable representations**

Add the two media capability keys to the direct and route-aware adapter
manifests without removing any `SIGNAL_REQUIRED_CAPABILITIES`.

- [ ] **Step 6: Run focused tests and boundary checks**

Run:

```bash
npx vitest run packages/connector-feishu/test packages/plugin-channel-feishu/test
npm run check:plugin-boundaries
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit transport and discovery support**

```bash
git add packages/exchange-spi/src/signal.ts packages/connector-feishu/src/open-api-client.ts packages/connector-feishu/src/signal-adapter.ts packages/plugin-channel-feishu/src/route-aware-signal-adapter.ts packages/connector-feishu/test/open-api-client.test.ts packages/connector-feishu/test/signal-adapter.test.ts packages/plugin-channel-feishu/test/route-aware-signal-adapter.test.ts
git commit -m "feat(channel): disclose rich message representations"
```

### Task 4: Regression, Local Interface Acceptance and Documentation

**Files:**
- Modify: `docs/architecture.md`
- Modify: `docs/roadmap.md`
- Modify: `docs/guides/agently-agent-runtime.md`
- Test: `packages/plugin-channel-feishu/test/route-aware-signal-adapter.test.ts`

**Interfaces:**
- Consumes: completed renderer and OpenAPI behavior from Tasks 1–3.
- Produces: documented channel-neutral media rule and an end-to-end Feishu payload regression.

- [ ] **Step 1: Add a production-topology integration assertion**

Compose `FeishuRouteAwareSignalAdapter` with the real `FeishuSignalAdapter`,
an authorized Handoff snapshot source, and a recording message client. Deliver
a canonical Result event that contains only versioned event facts; let the
Route Adapter obtain the `text/markdown` Result and labeled HTTPS link from the
snapshot. Assert exactly one outbound input with:

```ts
expect(messages.inputs).toHaveLength(1);
expect(messages.inputs[0]?.msg_type).toBe("post");
expect(messages.inputs[0]?.content).toContain(
  "[需求文档](https://example.com/doc)",
);
```

- [ ] **Step 2: Run the roundtrip test**

Run:

```bash
npx vitest run packages/plugin-channel-feishu/test/route-aware-signal-adapter.test.ts
```

Expected: PASS. This proves the production path obtains Result content through
`ChannelHandoffSnapshotSource`; it must not copy Result content into the
canonical event journal.

- [ ] **Step 3: Update durable architecture and operating documentation**

Document:

- `media_type` is the representation discriminator;
- producers own semantics;
- Channels own native rendering and safe-link policy;
- Feishu maps Markdown to `post/md`;
- plain text maps to `text`;
- interactive cards are reserved for structured interaction;
- unsafe links and unsupported types fail explicitly;
- local verification prompt must contain a labeled HTTPS link.

Do not duplicate the full spec; link to
`docs/superpowers/specs/2026-07-29-channel-neutral-message-content-design.md`.

- [ ] **Step 4: Run complete verification**

Run:

```bash
npm run verify
npm run verify:agent-runtime
npm run check:plugin-boundaries
npm run check:sensitive-observability
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 5: Restart and inspect the local Feishu stack**

Stop the currently running stack cleanly, then run:

```bash
WORK_FABRIC_ENV_FILE=/Users/bottleliu/work/git/agently/work-fabric/feishu.env \
WORK_FABRIC_CONFIG="$PWD/examples/config/local-feishu-assistant.bundle.yaml" \
npm run local:feishu:start
```

In another terminal run:

```bash
WORK_FABRIC_ENV_FILE=/Users/bottleliu/work/git/agently/work-fabric/feishu.env \
WORK_FABRIC_CONFIG="$PWD/examples/config/local-feishu-assistant.bundle.yaml" \
npm run local:feishu:status
```

Expected: service, Feishu provider and daily assistant are alive; required
Endpoints and Provider Citizens are online.

- [ ] **Step 6: Perform real-channel acceptance**

Ask the user to send:

```text
@AI助理 请回复一句“飞书富文本链接测试”，并附上名为“飞书开放平台”的链接：https://open.feishu.cn
```

Confirm through local delivery state that exactly one Result reply succeeds.
The user confirms visually that “飞书开放平台” is clickable and raw Markdown
markers are absent.

- [ ] **Step 7: Commit the regression and documentation**

```bash
git add packages/plugin-channel-feishu/test/route-aware-signal-adapter.test.ts docs/architecture.md docs/roadmap.md docs/guides/agently-agent-runtime.md docs/superpowers/plans/2026-07-29-channel-neutral-message-content.md
git commit -m "docs: define channel-native message rendering"
```

- [ ] **Step 8: Final repository check**

Run:

```bash
git status --short
git log -5 --oneline
```

Expected: only ignored or intentionally untracked local runtime state under
`var/` remains; no source or documentation changes are uncommitted.
