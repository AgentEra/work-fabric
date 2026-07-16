import type { RelationshipView, TimelineEntry } from "@work-fabric/sdk-typescript";

function e(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function renderHandoffDetail(
  handoffId: string,
  timeline: readonly TimelineEntry[],
  relationships: readonly RelationshipView[],
): string {
  return `<section><p class="eyebrow">Handoff detail</p><h1>${e(handoffId)}</h1>
    <div class="detail-grid"><article class="panel"><h2>Public timeline</h2><ol class="timeline">${timeline.length === 0 ? `<li class="empty">No projected events.</li>` : timeline.map((item) => `<li><span class="timeline-dot"></span><div><strong>${e(item.event_type.split(".").at(-2)?.replaceAll("_", " ") ?? item.event_type)}</strong><p>${e(item.actor_id)} via ${e(item.endpoint_id)}</p><time datetime="${e(item.occurred_at)}">${e(new Date(item.occurred_at).toLocaleString())}</time></div></li>`).join("")}</ol></article>
    <aside class="panel"><h2>Connections</h2><ul class="relations">${relationships.length === 0 ? `<li class="empty">No projected relationships.</li>` : relationships.map((item) => `<li><span>${e(item.relationship_kind.replaceAll("_", " "))}</span><strong>${e(item.target_id)}</strong></li>`).join("")}</ul></aside></div>
  </section>`;
}
