import type {
  AuditRecord,
  ConnectorDiscrepancyView,
  ConnectorIngressOperationalView,
  DeadLetterView,
  DeliveryAttemptView,
  DeliveryOperationalState,
  ProjectionOperationalStatus,
} from "@work-fabric/sdk-typescript";
import type { ConsolePresentation } from "../i18n.js";
import { renderConnectorIngress } from "./connectors.js";

function e(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

function rows(values: readonly string[], columns: number, emptyText: string): string {
  return values.length === 0
    ? `<tr><td colspan="${columns}" class="empty">${e(emptyText)}</td></tr>`
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

export function renderOperations(
  model: OperationsViewModel,
  presentation: ConsolePresentation,
  message = "",
): string {
  const text = presentation.text;
  const lag = model.projection?.lag;
  return `<section><p class="eyebrow">${e(text.operationsEyebrow)}</p><h1>${e(text.operationsTitle)}</h1>
    ${message === "" ? "" : `<div class="notice" role="status">${e(message)}</div>`}
    <div class="metric-grid"><article class="metric"><span>${e(text.projection)}</span><strong>${e(presentation.display("state", model.projection?.state ?? "unknown"))}</strong><small>${model.projection === null ? e(text.noStatusReturned) : `${model.projection.checkpoint_position} / ${model.projection.journal_position}`}</small></article>
    <article class="metric"><span>${e(text.observedLag)}</span><strong>${lag ?? "—"}</strong><small>${lag ?? e(text.unknown)} ${e(text.eventsAwaitingProjection)}</small></article>
    <article class="metric"><span>${e(text.execution)}</span><strong>${e(text.external)}</strong><small>${e(text.externalExecutionDescription)}</small></article></div>

    <form id="operations-filter" class="panel filter-panel"><label>${e(text.subscription)}<input name="subscription" maxlength="128" value="${e(model.filters?.subscription ?? "")}" /></label><label>${e(text.event)}<input name="event" maxlength="128" value="${e(model.filters?.event ?? "")}" /></label><label>${e(text.connector)}<input name="connector" maxlength="128" value="${e(model.filters?.connector ?? "")}" /></label><button>${e(text.inspect)}</button></form>

    <div class="operations-grid">
      <article class="panel"><h2>${e(text.delivery)}</h2><p class="fact">${e(text.position)} <strong>${model.delivery?.position ?? "—"}</strong></p><table><thead><tr><th>${e(text.attempt)}</th><th>${e(text.outcome)}</th><th>${e(text.when)}</th></tr></thead><tbody>${rows(model.deliveryAttempts.map((item) => `<tr><td>${item.attempt}</td><td>${e(presentation.display("outcome", item.outcome))}</td><td>${e(presentation.formatDate(item.attempted_at))}</td></tr>`), 3, text.noMatchingFacts)}</tbody></table><p class="fact">${e(text.deadLetters)}: <strong>${model.deadLetters.length}</strong></p></article>
      <article class="panel"><h2>${e(text.connectorIngress)}</h2>${renderConnectorIngress(model.connectorIngress, presentation)}</article>
      <article class="panel"><h2>${e(text.discrepancies)}</h2><table><thead><tr><th>${e(text.id)}</th><th>${e(text.connector)}</th><th>${e(text.status)}</th></tr></thead><tbody>${rows(model.discrepancies.map((item) => `<tr><td>${e(item.discrepancy_id)}</td><td>${e(item.connector_id)}</td><td>${e(presentation.display("state", item.status))}</td></tr>`), 3, text.noMatchingFacts)}</tbody></table></article>
      <article class="panel"><h2>${e(text.boundedAudit)}</h2><table><thead><tr><th>${e(text.principal)}</th><th>${e(text.operation)}</th><th>${e(text.outcome)}</th></tr></thead><tbody>${rows(model.audit.map((item) => `<tr><td>${e(item.principal_id)}</td><td>${e(item.operation)}</td><td>${e(presentation.display("outcome", item.outcome))}</td></tr>`), 3, text.noMatchingFacts)}</tbody></table></article>
    </div>

    <article class="panel recovery-panel"><div><h2>${e(text.recoveryTitle)}</h2><p>${e(text.recoveryDescription)}</p></div>
      <form id="recovery-form"><label>${e(text.expectedVersion)}<input name="expectedVersion" type="number" min="0" required /></label><label>${e(text.reasonCode)}<input name="reason" pattern="[A-Za-z0-9._:/-]+" maxlength="128" required placeholder="operator_requested" /></label><label class="confirm"><input name="confirmed" type="checkbox" required /> ${e(text.recoveryConfirmation)}</label><button type="submit">${e(text.requestRebuild)}</button></form>
    </article>
  </section>`;
}
