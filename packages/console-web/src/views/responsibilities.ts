import type { ResponsibilityView } from "@work-fabric/sdk-typescript";
import type { ConsolePresentation } from "../i18n.js";
import { routeHref } from "../router.js";

function escape(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

export function renderResponsibilities(
  items: readonly ResponsibilityView[],
  partitionId: string,
  freshness: { projected_position: number; journal_position: number; observed_at: string },
  presentation: ConsolePresentation,
): string {
  const text = presentation.text;
  const lag = freshness.journal_position - freshness.projected_position;
  const rows = items.length === 0
    ? `<tr><td colspan="5"><div class="empty"><strong>${escape(text.noHandoffsTitle)}</strong><span>${escape(text.noHandoffsDescription)}</span></div></td></tr>`
    : items.map((item) => `<tr>
        <td><a class="handoff-link" href="${routeHref(`/handoffs/${encodeURIComponent(item.handoff_id)}`, partitionId)}">${escape(item.handoff_id)}</a><span class="subtle">${escape(item.thread_id)}</span></td>
        <td><span class="status status-${escape(item.lifecycle_state)}">${escape(presentation.display("lifecycle", item.lifecycle_state))}</span></td>
        <td>${escape(item.current_responsible_actor?.actor_id ?? text.unassigned)}</td>
        <td>${escape(presentation.display("priority", item.priority))}</td>
        <td><time datetime="${escape(item.updated_at)}">${escape(presentation.formatDate(item.updated_at))}</time></td>
      </tr>`).join("");
  return `<section aria-labelledby="responsibility-title">
    <div class="section-heading"><div><p class="eyebrow">${escape(text.responsibilityEyebrow)}</p><h1 id="responsibility-title">${escape(text.responsibilityTitle)}</h1></div>
      <div class="freshness ${lag > 0 ? "is-stale" : ""}" title="${escape(text.observed)} ${escape(freshness.observed_at)}"><span></span>${lag > 0 ? `${lag} ${escape(text.eventsBehind)}` : escape(text.current)}</div></div>
    <div class="table-wrap"><table><thead><tr><th>${escape(text.handoff)}</th><th>${escape(text.state)}</th><th>${escape(text.responsible)}</th><th>${escape(text.priority)}</th><th>${escape(text.updated)}</th></tr></thead><tbody>${rows}</tbody></table></div>
  </section>`;
}
