import type { RelationshipView, TimelineEntry } from "@work-fabric/sdk-typescript";
import type { ConsolePresentation } from "../i18n.js";

function e(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function renderHandoffDetail(
  handoffId: string,
  timeline: readonly TimelineEntry[],
  relationships: readonly RelationshipView[],
  presentation: ConsolePresentation,
): string {
  const text = presentation.text;
  return `<section><p class="eyebrow">${e(text.handoffDetail)}</p><h1>${e(handoffId)}</h1>
    <div class="detail-grid"><article class="panel"><h2>${e(text.publicTimeline)}</h2><ol class="timeline">${timeline.length === 0 ? `<li class="empty">${e(text.noProjectedEvents)}</li>` : timeline.map((item) => {
      const event = item.event_type.split(".").at(-2) ?? item.event_type;
      return `<li><span class="timeline-dot"></span><div><strong>${e(presentation.display("event", event))}</strong><p>${e(item.actor_id)} ${e(text.via)} ${e(item.endpoint_id)}</p><time datetime="${e(item.occurred_at)}">${e(presentation.formatDate(item.occurred_at))}</time></div></li>`;
    }).join("")}</ol></article>
    <aside class="panel"><h2>${e(text.connections)}</h2><ul class="relations">${relationships.length === 0 ? `<li class="empty">${e(text.noProjectedRelationships)}</li>` : relationships.map((item) => `<li><span>${e(presentation.display("relationship", item.relationship_kind))}</span><strong>${e(item.target_id)}</strong></li>`).join("")}</ul></aside></div>
  </section>`;
}
