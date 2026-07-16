import type { WorkFabricClient } from "@work-fabric/sdk-typescript";
import { createConsoleClient } from "./client.js";
import { loadConsoleConfig, type ConsoleRuntimeConfig } from "./config.js";
import { consumeInvalidations, LiveRefresh } from "./live-refresh.js";
import { parseRoute, routeHref } from "./router.js";
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

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

function shell(content: string, partitionId: string): string {
  return `<div class="shell"><header><a class="brand" href="${routeHref("/", partitionId)}"><span class="brand-mark">WF</span><span>Work Fabric<small>connection console</small></span></a><nav aria-label="Primary"><a href="${routeHref("/", partitionId)}">Handoffs</a><a href="${routeHref("/operations", partitionId)}">Operations</a></nav><form id="partition-form"><label>Partition<input name="partition" value="${escapeHtml(partitionId)}" /></label><button>Open</button></form></header><main id="main" tabindex="-1">${content}</main><footer>Protocol facts, handoffs and operational visibility. Participant execution stays external.</footer></div>`;
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
  root.innerHTML = shell(`<div class="loading" role="status">Loading connection facts…</div>`, route.partitionId);
  try {
    if (route.kind === "responsibilities") {
      const page = await client.collaboration.listResponsibilities({
        partitionId: route.partitionId, limit: 50, ...(signal === undefined ? {} : { signal }),
      });
      root.innerHTML = shell(renderResponsibilities(page.items, route.partitionId, page.freshness), route.partitionId);
    } else if (route.kind === "handoff") {
      const [timeline, relationships] = await Promise.all([
        client.collaboration.listTimeline({ partitionId: route.partitionId, handoffId: route.handoffId, limit: 100, ...(signal === undefined ? {} : { signal }) }),
        client.collaboration.listRelationships({ partitionId: route.partitionId, handoffId: route.handoffId, limit: 100, ...(signal === undefined ? {} : { signal }) }),
      ]);
      root.innerHTML = shell(renderHandoffDetail(route.handoffId, timeline.items, relationships.items), route.partitionId);
    } else {
      root.innerHTML = shell(renderOperations(await operationsModel(route.partitionId, signal)), route.partitionId);
    }
  } catch (error) {
    if (signal?.aborted) return;
    root.innerHTML = shell(`<div class="error" role="alert"><strong>Unable to load Work Fabric facts</strong><p>${escapeHtml(error instanceof Error ? error.message : "Unknown error")}</p><button id="retry">Retry</button></div>`, route.partitionId);
  }
  bindInteractions(route.partitionId);
  syncInvalidation(route.partitionId);
}

function bindInteractions(partitionId: string): void {
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
      root.querySelector("main")?.insertAdjacentHTML("afterbegin", `<div class="notice" role="status">Recovery ${escapeHtml(result.kind)}.</div>`);
      form.reset();
      refresh?.invalidate();
    } catch (error) {
      root.querySelector("main")?.insertAdjacentHTML("afterbegin", `<div class="error" role="alert">${escapeHtml(error instanceof Error ? error.message : "Recovery denied")}</div>`);
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
  runtimeConfig = await loadConsoleConfig();
  client = createConsoleClient(runtimeConfig);
  window.addEventListener("popstate", () => { refresh?.invalidate(); });
  window.addEventListener("beforeunload", () => { streamAbort?.abort(); refresh?.stop(); });
  refresh = new LiveRefresh();
  refresh.start((signal) => load(signal));
}

start().catch((error: unknown) => {
  root.innerHTML = `<main class="fatal"><h1>Console unavailable</h1><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p></main>`;
});
