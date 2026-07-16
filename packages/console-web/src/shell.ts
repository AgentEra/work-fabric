import type { ConsolePresentation } from "./i18n.js";
import { routeHref } from "./router.js";

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

function option(value: "zh-CN" | "en", label: string, selected: string): string {
  return `<option value="${value}"${selected === value ? " selected" : ""}>${label}</option>`;
}

export function renderShell(
  content: string,
  partitionId: string,
  presentation: ConsolePresentation,
): string {
  const text = presentation.text;
  return `<a class="skip-link" href="#main">${escapeHtml(text.skipToContent)}</a><div class="shell"><header><a class="brand" href="${routeHref("/", partitionId)}"><span class="brand-mark">WF</span><span>Work Fabric<small>${escapeHtml(text.brandSubtitle)}</small></span></a><nav aria-label="${escapeHtml(text.primaryNavigation)}"><a href="${routeHref("/", partitionId)}">${escapeHtml(text.navigationHandoffs)}</a><a href="${routeHref("/operations", partitionId)}">${escapeHtml(text.navigationOperations)}</a></nav><label class="locale-control"><span class="sr-only">${escapeHtml(text.language)}</span><select id="locale-select" aria-label="${escapeHtml(text.language)}">${option("zh-CN", "中文", presentation.locale)}${option("en", "English", presentation.locale)}</select></label><form id="partition-form"><label>${escapeHtml(text.partition)}<input name="partition" value="${escapeHtml(partitionId)}" /></label><button>${escapeHtml(text.open)}</button></form></header><main id="main" tabindex="-1">${content}</main><footer>${escapeHtml(text.footer)}</footer></div>`;
}
