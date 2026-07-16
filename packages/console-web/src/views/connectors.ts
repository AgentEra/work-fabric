import type { ConnectorIngressOperationalView } from "@work-fabric/sdk-typescript";
import type { ConsolePresentation } from "../i18n.js";

function e(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

export function renderConnectorIngress(
  items: readonly ConnectorIngressOperationalView[],
  presentation: ConsolePresentation,
): string {
  const text = presentation.text;
  const rows = items.length === 0
    ? `<tr><td colspan="3" class="empty">${e(text.noMatchingFacts)}</td></tr>`
    : items.map((item) => `<tr><td>${e(item.ingress_id)}</td><td>${e(presentation.display("state", item.state))}</td><td>${e(item.last_error_code ?? "—")}</td></tr>`).join("");
  return `<table><thead><tr><th>${e(text.ingress)}</th><th>${e(text.state)}</th><th>${e(text.safeReason)}</th></tr></thead><tbody>${rows}</tbody></table>`;
}
