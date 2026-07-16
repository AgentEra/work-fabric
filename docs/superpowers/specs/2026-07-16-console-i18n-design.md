# Work Fabric Console internationalization design

## 1. Goal

Add a complete Simplified Chinese presentation to the read-mostly Console
without changing Work Fabric protocol facts, HTTP contracts, SDK behavior or
authority boundaries. English remains supported. The Console selects a useful
initial locale automatically and lets the user switch languages at runtime.

Supported locales for this increment are:

- `en`: existing English presentation;
- `zh-CN`: Simplified Chinese presentation.

## 2. Boundary

Internationalization is a Console presentation concern. It may translate
navigation, headings, labels, help text, loading and empty states, recovery
messages, lifecycle/status display names and human-readable timestamps.

It must not translate or rewrite machine facts such as Tenant, Partition,
Handoff, Actor, Endpoint, Connector, Principal or Subscription identifiers;
protocol event type values; reason and error codes; audit operation names; or
external content. The SDK and API continue to exchange canonical values.

## 3. Locale selection and switching

Locale resolution uses this order:

1. a previously selected supported locale stored under the dedicated
   `work-fabric-console-locale` browser preference;
2. the first supported match in `navigator.languages` or
   `navigator.language`;
3. English.

Any language tag beginning with `zh` resolves to `zh-CN`; all unsupported tags
resolve to `en`. Invalid stored values are ignored.

The Console header exposes one compact language selector with `中文` and
`English`. Selecting a locale stores only the locale code, updates the document
`lang` attribute and re-renders the current route. It does not navigate, alter
the URL, make a protocol write, acknowledge a Delivery or persist domain data.
The existing refresh controller remains responsible for data fetching.

The browser preference is UI-only. Tenant, Partition, Handoff, authentication,
query filters and protocol facts remain prohibited from browser storage.

## 4. Language-pack architecture

Add a small presentation module with:

- a canonical English message catalog defining the complete key shape;
- a `zh-CN` catalog required by TypeScript to satisfy the same key shape;
- locale resolution, preference loading/saving and translation helpers;
- interpolation parameters for bounded dynamic phrases;
- locale-aware date formatting through `Intl.DateTimeFormat`.

Views receive an explicit presentation object instead of importing global
state. This keeps the render functions deterministic and independently
testable. `app.ts` owns the active locale, passes the presentation object to
the shell and views, and binds the language selector alongside existing
interactions.

The language catalogs contain presentation text only. They do not contain HTML
from external sources. Dynamic values continue through the existing escaping
boundaries before entering rendered markup.

## 5. Translation coverage

Both catalogs cover:

- brand subtitle, primary navigation, partition form and footer;
- loading, fatal, retry, denied and unknown-error states;
- responsibility list headings, columns, empty state and freshness labels;
- Handoff detail headings, timeline event display names and relationship kinds;
- operations headings, metrics, filters, tables and empty states;
- projection recovery explanation, confirmation, submission and result notices;
- common lifecycle, priority, outcome and connector-state display names.

When a known enum value has no explicit display entry, the Console falls back
to the canonical value rather than inventing a translation. Unknown service
errors and safe reason codes remain unchanged.

## 6. Rendering and data flow

At startup the Console loads runtime configuration and resolves the locale.
Each refresh parses the current route, renders the localized loading shell,
queries the same SDK endpoints, then renders the localized view. A locale
change updates the active presentation and invalidates the current refresh so
the route is rendered consistently from one catalog.

The locale selector never creates a second source of protocol truth. Live SSE
invalidation, bounded polling, Abort behavior and single-request refresh limits
remain unchanged.

## 7. Accessibility and layout

The selector has an accessible label in the active locale and uses a native
`select`. The document `lang` attribute changes with the active locale so
screen readers and browser typography use the correct language. Existing
keyboard, responsive and reduced-motion behavior remains intact. Chinese copy
must fit the current header at supported responsive breakpoints without hiding
the partition control or primary navigation.

## 8. Error handling

Browser preference access is best-effort because storage may be disabled. A
storage read or write failure does not prevent Console startup or locale
switching for the current session. Missing or unsupported locale values fall
back to English. A missing message key is prevented by the catalog type and is
therefore a build-time error.

## 9. Verification

Automated tests must prove:

- both catalogs implement the same complete key set;
- Chinese browser-language resolution selects `zh-CN` and unsupported locales
  select English;
- a valid stored preference overrides browser detection while invalid storage
  is ignored;
- responsibility, Handoff and operations views render representative Chinese
  copy while escaping machine facts;
- the language selector and document language update without protocol writes;
- only the dedicated locale code may be persisted;
- Console dependency and sensitive-data boundary checks still pass;
- the production Console build succeeds.

Browser verification must cover the Handoff list, Handoff timeline and
operations page in Chinese, switch to English, switch back to Chinese, refresh
the page and confirm that the preference is restored.

## 10. Non-goals

This increment does not add server-side locale negotiation, translated API
errors, additional locales, customer-editable catalogs, right-to-left layout,
automatic translation, localization of external content or any change to the
Console's read-mostly authority model.
