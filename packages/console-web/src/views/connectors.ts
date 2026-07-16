import type { ConnectorIngressOperationalView } from "@work-fabric/sdk-typescript";

function e(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

export function renderConnectorIngress(items: readonly ConnectorIngressOperationalView[]): string {
  const rows = items.length === 0
    ? `<tr><td colspan="3" class="empty">No matching facts.</td></tr>`
    : items.map((item) => `<tr><td>${e(item.ingress_id)}</td><td>${e(item.state)}</td><td>${e(item.last_error_code ?? "—")}</td></tr>`).join("");
  return `<table><thead><tr><th>Ingress</th><th>State</th><th>Safe reason</th></tr></thead><tbody>${rows}</tbody></table>`;
}
