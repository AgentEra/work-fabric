import type { ResponsibilityView } from "@work-fabric/sdk-typescript";
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
): string {
  const lag = freshness.journal_position - freshness.projected_position;
  const rows = items.length === 0
    ? `<tr><td colspan="5"><div class="empty"><strong>No handoffs in this partition</strong><span>Connected participants have not transferred responsibility here yet.</span></div></td></tr>`
    : items.map((item) => `<tr>
        <td><a class="handoff-link" href="${routeHref(`/handoffs/${encodeURIComponent(item.handoff_id)}`, partitionId)}">${escape(item.handoff_id)}</a><span class="subtle">${escape(item.thread_id)}</span></td>
        <td><span class="status status-${escape(item.lifecycle_state)}">${escape(item.lifecycle_state.replaceAll("_", " "))}</span></td>
        <td>${escape(item.current_responsible_actor?.actor_id ?? "Unassigned")}</td>
        <td>${escape(item.priority)}</td>
        <td><time datetime="${escape(item.updated_at)}">${escape(new Date(item.updated_at).toLocaleString())}</time></td>
      </tr>`).join("");
  return `<section aria-labelledby="responsibility-title">
    <div class="section-heading"><div><p class="eyebrow">Responsibility map</p><h1 id="responsibility-title">Current handoffs</h1></div>
      <div class="freshness ${lag > 0 ? "is-stale" : ""}" title="Observed ${escape(freshness.observed_at)}"><span></span>${lag > 0 ? `${lag} events behind` : "Current"}</div></div>
    <div class="table-wrap"><table><thead><tr><th>Handoff</th><th>State</th><th>Responsible</th><th>Priority</th><th>Updated</th></tr></thead><tbody>${rows}</tbody></table></div>
  </section>`;
}
