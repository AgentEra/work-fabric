# Console Internationalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add complete `en` and `zh-CN` Console language packs with browser-language detection, a persistent language selector and locale-aware presentation across every Console view.

**Architecture:** A pure `i18n.ts` module owns typed catalogs, locale resolution, the dedicated UI preference and date/value presentation. Deterministic shell and view renderers receive an explicit `ConsolePresentation`; `app.ts` alone owns the active locale and binds the selector without changing protocol state or routes.

**Tech Stack:** TypeScript, Vite, Vitest, native `Intl.DateTimeFormat`, native `localStorage`, existing string-rendered Console UI.

## Global Constraints

- Supported locales are exactly `en` and `zh-CN`.
- Locale resolution order is stored supported preference, browser languages, then English.
- The only browser-storage key is `work-fabric-console-locale`, and its only valid values are `en` and `zh-CN`.
- Machine identifiers, protocol values, reason/error codes, audit operation names and external content remain canonical.
- Locale changes do not navigate, write protocol state, acknowledge Deliveries or create a second state store.
- Views remain deterministic and import no global locale state.
- Missing catalog keys are TypeScript build errors.
- Storage failures are non-fatal.

---

### Task 1: Typed language packs and locale preference

**Files:**
- Create: `packages/console-web/src/i18n.ts`
- Create: `packages/console-web/test/i18n.test.ts`

**Interfaces:**
- Produces: `ConsoleLocale = "en" | "zh-CN"`.
- Produces: `ConsolePresentation` with `locale`, `text`, `formatDate(value)`, `display(group, value)`.
- Produces: `resolveLocale(stored, browserLanguages)`, `readLocale(storage, browserLanguages)` and `saveLocale(storage, locale)`.
- Produces: `LOCALE_STORAGE_KEY = "work-fabric-console-locale"`.

- [ ] **Step 1: Write failing locale and catalog tests**

Create tests that assert exact locale precedence, safe storage behavior, translated representative keys and localized dates:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  LOCALE_STORAGE_KEY,
  createPresentation,
  readLocale,
  resolveLocale,
  saveLocale,
} from "../src/i18n.js";

describe("Console i18n", () => {
  it("resolves stored preference before browser language and falls back to English", () => {
    expect(resolveLocale("en", ["zh-CN"])).toBe("en");
    expect(resolveLocale(null, ["zh-Hans-CN", "en"])).toBe("zh-CN");
    expect(resolveLocale("invalid", ["fr-FR"])).toBe("en");
  });

  it("persists only the dedicated supported locale preference", () => {
    const storage = { getItem: vi.fn(() => "zh-CN"), setItem: vi.fn() };
    expect(readLocale(storage, ["en-US"])).toBe("zh-CN");
    saveLocale(storage, "en");
    expect(storage.setItem).toHaveBeenCalledWith(LOCALE_STORAGE_KEY, "en");
  });

  it("survives disabled browser storage", () => {
    const storage = {
      getItem: () => { throw new Error("disabled"); },
      setItem: () => { throw new Error("disabled"); },
    };
    expect(readLocale(storage, ["zh-CN"])).toBe("zh-CN");
    expect(() => saveLocale(storage, "zh-CN")).not.toThrow();
  });

  it("provides complete Chinese presentation without rewriting unknown facts", () => {
    const zh = createPresentation("zh-CN");
    expect(zh.text.navigationHandoffs).toBe("交接");
    expect(zh.text.operationsTitle).toBe("连接健康状态");
    expect(zh.display("lifecycle", "verified")).toBe("已验收");
    expect(zh.display("lifecycle", "customer_specific")).toBe("customer_specific");
    expect(zh.formatDate("2026-07-16T00:00:00.000Z")).not.toBe("");
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- packages/console-web/test/i18n.test.ts`

Expected: FAIL because `../src/i18n.js` does not exist.

- [ ] **Step 3: Implement the typed catalogs and pure helpers**

Create a flat `ConsoleMessages` interface covering shell, common state,
responsibility, Handoff, operations, recovery and selector text. Define the
English catalog as the canonical implementation and the Chinese catalog with
the same interface. Implement:

```ts
export type ConsoleLocale = "en" | "zh-CN";
export const LOCALE_STORAGE_KEY = "work-fabric-console-locale";

export interface ConsolePresentation {
  readonly locale: ConsoleLocale;
  readonly text: Readonly<ConsoleMessages>;
  formatDate(value: string): string;
  display(group: "lifecycle" | "priority" | "event" | "relationship" | "state" | "outcome", value: string): string;
}

export function resolveLocale(stored: string | null, browserLanguages: readonly string[]): ConsoleLocale {
  if (stored === "en" || stored === "zh-CN") return stored;
  return browserLanguages.some((language) => language.toLowerCase().startsWith("zh"))
    ? "zh-CN"
    : "en";
}

export function readLocale(
  storage: Pick<Storage, "getItem"> | undefined,
  browserLanguages: readonly string[],
): ConsoleLocale {
  try { return resolveLocale(storage?.getItem(LOCALE_STORAGE_KEY) ?? null, browserLanguages); }
  catch { return resolveLocale(null, browserLanguages); }
}

export function saveLocale(
  storage: Pick<Storage, "setItem"> | undefined,
  locale: ConsoleLocale,
): void {
  try { storage?.setItem(LOCALE_STORAGE_KEY, locale); } catch { /* UI preference is best-effort. */ }
}
```

Use `new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" })`
inside `createPresentation`. Use bounded lookup tables for known canonical
values and return the original value for unknown facts.

- [ ] **Step 4: Run the i18n test and typecheck**

Run: `npm test -- packages/console-web/test/i18n.test.ts && npm run typecheck`

Expected: all i18n tests pass and TypeScript reports no errors.

- [ ] **Step 5: Commit the language-pack core**

```bash
git add packages/console-web/src/i18n.ts packages/console-web/test/i18n.test.ts
git commit -m "feat(console): add typed English and Chinese language packs"
```

---

### Task 2: Localize deterministic Console views

**Files:**
- Modify: `packages/console-web/src/views/responsibilities.ts`
- Modify: `packages/console-web/src/views/handoff-detail.ts`
- Modify: `packages/console-web/src/views/connectors.ts`
- Modify: `packages/console-web/src/views/operations.ts`
- Modify: `packages/console-web/test/console.test.ts`
- Modify: `packages/console-web/test/operations-console.test.ts`

**Interfaces:**
- Consumes: `ConsolePresentation` and `createPresentation(locale)` from Task 1.
- Produces: every view renderer accepts a final `presentation: ConsolePresentation` argument.
- Preserves: existing escaping and canonical values in attributes and identifiers.

- [ ] **Step 1: Add failing Chinese view tests**

Update fixtures to call each renderer with `createPresentation("zh-CN")` and
assert Chinese labels plus escaped canonical facts:

```ts
const zh = createPresentation("zh-CN");
const html = renderResponsibilities(items, "north", freshness, zh);
expect(html).toContain("当前交接");
expect(html).toContain("责任主体");
expect(html).toContain("handoff-&lt;one&gt;");
expect(html).not.toContain("handoff-<one>");
```

For operations assert `连接健康状态`, `等待可见性投影的事件`, `有界审计`
and the unchanged safe reason `mapping_invalid`. For Handoff detail assert
`公开时间线`, `已接受`, and unchanged Actor/Endpoint identifiers.

- [ ] **Step 2: Run view tests and verify RED**

Run: `npm test -- packages/console-web/test/console.test.ts packages/console-web/test/operations-console.test.ts`

Expected: FAIL because renderers do not accept/use `ConsolePresentation` and Chinese text is absent.

- [ ] **Step 3: Thread presentation through every renderer**

Change signatures to:

```ts
renderResponsibilities(items, partitionId, freshness, presentation)
renderHandoffDetail(handoffId, timeline, relationships, presentation)
renderConnectorIngress(items, presentation)
renderOperations(model, presentation, message = "")
```

Replace every human-facing literal with `presentation.text` and every known
canonical display value with `presentation.display`. Keep IDs, operation names,
error/reason codes and URI-like values unchanged. Replace direct
`toLocaleString()` calls with `presentation.formatDate()`.

- [ ] **Step 4: Run Console view tests**

Run: `npm test -- packages/console-web/test/console.test.ts packages/console-web/test/operations-console.test.ts`

Expected: all view tests pass in both English and Chinese fixtures.

- [ ] **Step 5: Commit localized views**

```bash
git add packages/console-web/src/views packages/console-web/test/console.test.ts packages/console-web/test/operations-console.test.ts
git commit -m "feat(console): localize collaboration and operations views"
```

---

### Task 3: Localized shell and runtime language switching

**Files:**
- Create: `packages/console-web/src/shell.ts`
- Modify: `packages/console-web/src/app.ts`
- Modify: `packages/console-web/src/styles.css`
- Create: `packages/console-web/test/shell.test.ts`

**Interfaces:**
- Consumes: `ConsolePresentation`, `ConsoleLocale`, `readLocale`, `saveLocale`.
- Produces: `renderShell(content, partitionId, presentation)`.
- Produces: one `#locale-select` native selector whose value is the active locale.

- [ ] **Step 1: Write failing shell tests**

```ts
import { createPresentation } from "../src/i18n.js";
import { renderShell } from "../src/shell.js";

it("renders the Chinese shell and a two-language selector", () => {
  const html = renderShell("<p>content</p>", "north", createPresentation("zh-CN"));
  expect(html).toContain("协作连接控制台");
  expect(html).toContain("交接");
  expect(html).toContain('id="locale-select"');
  expect(html).toContain('<option value="zh-CN" selected>中文</option>');
  expect(html).toContain('value="north"');
});
```

- [ ] **Step 2: Run shell tests and verify RED**

Run: `npm test -- packages/console-web/test/shell.test.ts`

Expected: FAIL because `src/shell.ts` does not exist.

- [ ] **Step 3: Extract and localize the shell**

Move the existing shell HTML from `app.ts` into `shell.ts`, preserve all
escaping, routes and semantic structure, and add:

```html
<label class="locale-control">
  <span class="sr-only">Language</span>
  <select id="locale-select" aria-label="Language">
    <option value="zh-CN">中文</option>
    <option value="en">English</option>
  </select>
</label>
```

Localize the accessible label and select the current locale in generated HTML.

- [ ] **Step 4: Bind locale ownership in `app.ts`**

Initialize once at startup:

```ts
let presentation = createPresentation("en");

function browserLanguages(): readonly string[] {
  return navigator.languages.length > 0 ? navigator.languages : [navigator.language];
}
```

After runtime config loads, resolve with `readLocale(window.localStorage,
browserLanguages())`, create the presentation and set
`document.documentElement.lang = presentation.locale`. Pass presentation to
all shells and views.

Bind `#locale-select` change after each render. For `en` or `zh-CN`, update the
in-memory presentation, best-effort save the preference, update the document
language and call `refresh?.invalidate()`. Reject any other DOM value without
changing locale. Do not call `navigate` and do not alter the URL.

Translate loading, fatal, retry, recovery success/denial and unknown-error
fallbacks. SDK error messages and reason codes remain canonical.

- [ ] **Step 5: Add responsive selector styles**

Extend `styles.css` with `.locale-control` and selector styles matching existing
header controls. At the current mobile breakpoint allow the control to wrap
without hiding navigation or the partition form. Reuse existing focus-visible,
color and reduced-motion conventions.

- [ ] **Step 6: Run shell, Console and refresh tests**

Run: `npm test -- packages/console-web/test`

Expected: all Console tests pass.

- [ ] **Step 7: Commit runtime switching**

```bash
git add packages/console-web/src/app.ts packages/console-web/src/shell.ts packages/console-web/src/styles.css packages/console-web/test/shell.test.ts
git commit -m "feat(console): add runtime language switching"
```

---

### Task 4: Documentation, production build and browser acceptance

**Files:**
- Modify: `docs/console.md`
- Modify generated files under: `packages/console-web/dist/`

**Interfaces:**
- Consumes: completed bilingual Console.
- Produces: documented locale behavior and rebuilt deployable assets.

- [ ] **Step 1: Document locale behavior and storage boundary**

Add a `Language` section to `docs/console.md` stating:

```md
The Console ships `en` and `zh-CN` catalogs. A valid value stored under
`work-fabric-console-locale` overrides browser-language detection; otherwise
Chinese browser languages select `zh-CN` and all other languages select `en`.
The header selector changes presentation only. This UI preference is the only
Console value stored in browser storage; protocol facts, filters and credentials
remain prohibited.
```

- [ ] **Step 2: Run complete automated verification**

Run:

```bash
npm run typecheck
npm test
npm run conformance
npm run console:build
npm run check:console-boundaries
```

Expected: zero failures, WFPP conformance `126/126`, and a successful Vite
production build whose boundary report stays within its configured asset limit.

- [ ] **Step 3: Verify the live Console in a browser**

With the SQLite API and local Console host running, verify:

1. clear only `work-fabric-console-locale`;
2. open the Handoff list under a Chinese browser language and observe Chinese;
3. open `handoff_local_trial_1` and verify five localized timeline events;
4. open Operations and verify Chinese metrics, tables and recovery form;
5. switch to English and verify the same canonical IDs remain unchanged;
6. switch back to Chinese, reload and verify the preference is restored;
7. inspect browser errors and confirm there are none.

- [ ] **Step 4: Review repository boundaries and commit**

Run: `git diff --check && git status --short`

Expected: only the planned source, tests, documentation and rebuilt Console
assets are changed.

```bash
git add docs/console.md packages/console-web/dist
git commit -m "docs(console): publish bilingual Console assets"
```

- [ ] **Step 5: Push the completed feature**

Run: `git push origin main`

Expected: the verified commits are published to `origin/main`.
