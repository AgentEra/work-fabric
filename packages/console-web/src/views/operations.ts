import type {
  AuditRecord,
  ConnectorDiscrepancyView,
  ConnectorIngressOperationalView,
  DeadLetterView,
  DeliveryAttemptView,
  DeliveryOperationalState,
  ProjectionOperationalStatus,
} from "@work-fabric/sdk-typescript";
import { renderConnectorIngress } from "./connectors.js";

function e(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

function rows(values: readonly string[], columns: number): string {
  return values.length === 0
    ? `<tr><td colspan="${columns}" class="empty">No matching facts.</td></tr>`
    : values.join("");
}

export interface OperationsViewModel {
  readonly projection: ProjectionOperationalStatus | null;
  readonly delivery: DeliveryOperationalState | null;
  readonly deliveryAttempts: readonly DeliveryAttemptView[];
  readonly deadLetters: readonly DeadLetterView[];
  readonly connectorIngress: readonly ConnectorIngressOperationalView[];
  readonly discrepancies: readonly ConnectorDiscrepancyView[];
  readonly audit: readonly AuditRecord[];
  readonly filters?: { readonly subscription?: string; readonly event?: string; readonly connector?: string };
}

export function renderOperations(model: OperationsViewModel, message = ""): string {
  const lag = model.projection?.lag;
  return `<section><p class="eyebrow">Operational visibility</p><h1>Connection health</h1>
    ${message === "" ? "" : `<div class="notice" role="status">${e(message)}</div>`}
    <div class="metric-grid"><article class="metric"><span>Projection</span><strong>${e(model.projection?.state ?? "unknown")}</strong><small>${model.projection === null ? "No status returned" : `${model.projection.checkpoint_position} / ${model.projection.journal_position}`}</small></article>
    <article class="metric"><span>Observed lag</span><strong>${lag ?? "—"}</strong><small>${lag ?? "Unknown"} events awaiting visibility projection</small></article>
    <article class="metric"><span>Execution</span><strong>external</strong><small>Work Fabric does not run participant work</small></article></div>

    <form id="operations-filter" class="panel filter-panel"><label>Subscription<input name="subscription" maxlength="128" value="${e(model.filters?.subscription ?? "")}" /></label><label>Event<input name="event" maxlength="128" value="${e(model.filters?.event ?? "")}" /></label><label>Connector<input name="connector" maxlength="128" value="${e(model.filters?.connector ?? "")}" /></label><button>Inspect</button></form>

    <div class="operations-grid">
      <article class="panel"><h2>Delivery</h2><p class="fact">Position <strong>${model.delivery?.position ?? "—"}</strong></p><table><thead><tr><th>Attempt</th><th>Outcome</th><th>When</th></tr></thead><tbody>${rows(model.deliveryAttempts.map((item) => `<tr><td>${item.attempt}</td><td>${e(item.outcome)}</td><td>${e(item.attempted_at)}</td></tr>`), 3)}</tbody></table><p class="fact">Dead letters: <strong>${model.deadLetters.length}</strong></p></article>
      <article class="panel"><h2>Connector ingress</h2>${renderConnectorIngress(model.connectorIngress)}</article>
      <article class="panel"><h2>Discrepancies</h2><table><thead><tr><th>ID</th><th>Connector</th><th>Status</th></tr></thead><tbody>${rows(model.discrepancies.map((item) => `<tr><td>${e(item.discrepancy_id)}</td><td>${e(item.connector_id)}</td><td>${e(item.status)}</td></tr>`), 3)}</tbody></table></article>
      <article class="panel"><h2>Bounded audit</h2><table><thead><tr><th>Principal</th><th>Operation</th><th>Outcome</th></tr></thead><tbody>${rows(model.audit.map((item) => `<tr><td>${e(item.principal_id)}</td><td>${e(item.operation)}</td><td>${e(item.outcome)}</td></tr>`), 3)}</tbody></table></article>
    </div>

    <article class="panel recovery-panel"><div><h2>Explicit projection recovery</h2><p>Records one authorized rebuild request. It does not decide when a rebuild is needed.</p></div>
      <form id="recovery-form"><label>Expected version<input name="expectedVersion" type="number" min="0" required /></label><label>Reason code<input name="reason" pattern="[A-Za-z0-9._:/-]+" maxlength="128" required placeholder="operator_requested" /></label><label class="confirm"><input name="confirmed" type="checkbox" required /> I confirm this bounded recovery request</label><button type="submit">Request rebuild</button></form>
    </article>
  </section>`;
}
