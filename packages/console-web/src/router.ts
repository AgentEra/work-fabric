export type ConsoleRoute =
  | { readonly kind: "responsibilities"; readonly partitionId: string }
  | { readonly kind: "handoff"; readonly handoffId: string; readonly partitionId: string }
  | { readonly kind: "operations"; readonly partitionId: string };

export function parseRoute(url: URL): ConsoleRoute {
  const partitionId = url.searchParams.get("partition") ?? "default";
  const handoff = /^\/handoffs\/([^/]+)$/.exec(url.pathname);
  if (handoff?.[1] !== undefined) {
    return { kind: "handoff", handoffId: decodeURIComponent(handoff[1]), partitionId };
  }
  if (url.pathname === "/operations") return { kind: "operations", partitionId };
  return { kind: "responsibilities", partitionId };
}

export function routeHref(path: string, partitionId: string): string {
  return `${path}?partition=${encodeURIComponent(partitionId)}`;
}
