import type { WorkFabricClient } from "@work-fabric/sdk-typescript";
import { createConsoleClient } from "./client.js";
import { loadConsoleConfig, type ConsoleRuntimeConfig } from "./config.js";
import {
  createPresentation,
  readBrowserLocale,
  saveBrowserLocale,
  type ConsoleLocale,
} from "./i18n.js";
import { consumeInvalidations, LiveRefresh } from "./live-refresh.js";
import { parseRoute, routeHref } from "./router.js";
import { renderShell } from "./shell.js";
import { renderHandoffDetail } from "./views/handoff-detail.js";
import { renderOperations, type OperationsViewModel } from "./views/operations.js";
import { renderResponsibilities } from "./views/responsibilities.js";
import "./styles.css";

const root = document.querySelector<HTMLElement>("#app") ?? (() => {
  throw new Error("Console root is missing");
})();

let client: WorkFabricClient;
let runtimeConfig: ConsoleRuntimeConfig;
let refresh: LiveRefresh | null = null;
let streamAbort: AbortController | null = null;
let streamPartition: string | null = null;
let presentation = createPresentation("en");

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

function browserLanguages(): readonly string[] {
  return navigator.languages.length > 0 ? navigator.languages : [navigator.language];
}

function queryValue(name: string): string | undefined {
  const value = new URL(location.href).searchParams.get(name)?.trim();
  return value === undefined || value === "" ? undefined : value;
}

async function operationsModel(partitionId: string, signal?: AbortSignal): Promise<OperationsViewModel> {
  const common = signal === undefined ? {} : { signal };
  const subscription = queryValue("subscription");
  const event = queryValue("event");
  const connector = queryValue("connector");
  const [projection, delivery, attempts, deadLetters, ingress, discrepancies, audit] = await Promise.all([
    client.operations.getProjectionStatus({ projectorId: "workfabric.collaboration.visibility.v1", partitionId, ...common }).catch(() => null),
    subscription === undefined ? null : client.operations.getDeliveryState({ subscriptionId: subscription, partitionId, ...common }).catch(() => null),
    subscription === undefined || event === undefined ? { items: [] as const } : client.operations.listDeliveryAttemptPage({ subscriptionId: subscription, eventId: event, limit: 25, ...common }),
    subscription === undefined ? { items: [] as const } : client.operations.listDeadLetters({ subscriptionId: subscription, ...(event === undefined ? {} : { eventId: event }), limit: 25, ...common }),
    connector === undefined ? { items: [] as const } : client.operations.listConnectorIngress({ connectorId: connector, limit: 25, ...common }),
    client.operations.listDiscrepancies({ ...(connector === undefined ? {} : { connectorId: connector }), limit: 25, ...common }),
    client.operations.listAudit({ limit: 25, ...common }),
  ]);
  return {
    projection,
    delivery,
    deliveryAttempts: attempts.items,
    deadLetters: deadLetters.items,
    connectorIngress: ingress.items,
    discrepancies: discrepancies.items,
    audit: audit.items,
    filters: { ...(subscription === undefined ? {} : { subscription }), ...(event === undefined ? {} : { event }), ...(connector === undefined ? {} : { connector }) },
  };
}

async function load(signal?: AbortSignal): Promise<void> {
  const route = parseRoute(new URL(location.href));
  root.innerHTML = renderShell(`<div class="loading" role="status">${escapeHtml(presentation.text.loading)}</div>`, route.partitionId, presentation);
  try {
    if (route.kind === "responsibilities") {
      const page = await client.collaboration.listResponsibilities({
        partitionId: route.partitionId, limit: 50, ...(signal === undefined ? {} : { signal }),
      });
      root.innerHTML = renderShell(renderResponsibilities(page.items, route.partitionId, page.freshness, presentation), route.partitionId, presentation);
    } else if (route.kind === "handoff") {
      const [timeline, relationships] = await Promise.all([
        client.collaboration.listTimeline({ partitionId: route.partitionId, handoffId: route.handoffId, limit: 100, ...(signal === undefined ? {} : { signal }) }),
        client.collaboration.listRelationships({ partitionId: route.partitionId, handoffId: route.handoffId, limit: 100, ...(signal === undefined ? {} : { signal }) }),
      ]);
      root.innerHTML = renderShell(renderHandoffDetail(route.handoffId, timeline.items, relationships.items, presentation), route.partitionId, presentation);
    } else {
      root.innerHTML = renderShell(renderOperations(await operationsModel(route.partitionId, signal), presentation), route.partitionId, presentation);
    }
  } catch (error) {
    if (signal?.aborted) return;
    root.innerHTML = renderShell(`<div class="error" role="alert"><strong>${escapeHtml(presentation.text.loadErrorTitle)}</strong><p>${escapeHtml(error instanceof Error ? error.message : presentation.text.unknownError)}</p><button id="retry">${escapeHtml(presentation.text.retry)}</button></div>`, route.partitionId, presentation);
  }
  bindInteractions(route.partitionId);
  syncInvalidation(route.partitionId);
}

function bindInteractions(partitionId: string): void {
  root.querySelector<HTMLSelectElement>("#locale-select")?.addEventListener("change", (event) => {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (value !== "en" && value !== "zh-CN") return;
    presentation = createPresentation(value as ConsoleLocale);
    saveBrowserLocale(presentation.locale);
    document.documentElement.lang = presentation.locale;
    refresh?.invalidate();
  });
  root.querySelector<HTMLFormElement>("#partition-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const value = String(new FormData(form).get("partition") ?? "").trim();
    if (value !== "") navigate(routeHref("/", value));
  });
  root.querySelector<HTMLFormElement>("#operations-filter")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const target = new URL("/operations", location.origin);
    target.searchParams.set("partition", partitionId);
    for (const name of ["subscription", "event", "connector"]) {
      const value = String(new FormData(form).get(name) ?? "").trim();
      if (value !== "") target.searchParams.set(name, value);
    }
    navigate(`${target.pathname}${target.search}`);
  });
  root.querySelector("#retry")?.addEventListener("click", () => { refresh?.invalidate(); });
  root.querySelector<HTMLFormElement>("#recovery-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    if (data.get("confirmed") === null) return;
    const button = form.querySelector<HTMLButtonElement>("button");
    if (button !== null) button.disabled = true;
    try {
      const result = await client.operations.requestRecovery({
        idempotencyKey: `console-${crypto.randomUUID()}`,
        target: { kind: "projection_rebuild", projector_id: "workfabric.collaboration.visibility.v1", partition_id: partitionId },
        expectedVersion: Number(data.get("expectedVersion")), reason: String(data.get("reason")),
      });
      root.querySelector("main")?.insertAdjacentHTML("afterbegin", `<div class="notice" role="status">${escapeHtml(presentation.text.recoveryResultPrefix)} ${escapeHtml(result.kind)}.</div>`);
      form.reset();
      refresh?.invalidate();
    } catch (error) {
      root.querySelector("main")?.insertAdjacentHTML("afterbegin", `<div class="error" role="alert">${escapeHtml(error instanceof Error ? error.message : presentation.text.recoveryDenied)}</div>`);
    } finally {
      if (button !== null) button.disabled = false;
    }
  });
  root.querySelectorAll<HTMLAnchorElement>("a[href^='/']").forEach((anchor) => anchor.addEventListener("click", (event) => {
    event.preventDefault();
    navigate(`${new URL(anchor.href).pathname}${new URL(anchor.href).search}`);
  }));
}

function navigate(href: string): void {
  history.pushState({}, "", href);
  refresh?.invalidate();
}

function syncInvalidation(partitionId: string): void {
  if (runtimeConfig.invalidationSubscriptionId === undefined || refresh === null || streamPartition === partitionId) return;
  streamAbort?.abort();
  streamAbort = new AbortController();
  streamPartition = partitionId;
  const stream = client.subscriptions.stream(
    runtimeConfig.invalidationSubscriptionId,
    { partitionId },
    { signal: streamAbort.signal },
  );
  void consumeInvalidations(stream, refresh).catch(() => {
    // Bounded polling remains active if the authenticated stream is unavailable.
  });
}

async function start(): Promise<void> {
  presentation = createPresentation(readBrowserLocale(browserLanguages()));
  document.documentElement.lang = presentation.locale;
  runtimeConfig = await loadConsoleConfig();
  client = createConsoleClient(runtimeConfig);
  window.addEventListener("popstate", () => { refresh?.invalidate(); });
  window.addEventListener("beforeunload", () => { streamAbort?.abort(); refresh?.stop(); });
  refresh = new LiveRefresh();
  refresh.start((signal) => load(signal));
}

start().catch((error: unknown) => {
  root.innerHTML = `<main class="fatal"><h1>${escapeHtml(presentation.text.fatalTitle)}</h1><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p></main>`;
});
