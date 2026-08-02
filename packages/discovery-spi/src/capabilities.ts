export const DISCOVERY_PROFILE = "workfabric.discovery.v1" as const;
export const DISCOVERY_MAX_MESSAGE_BYTES = 65_536;

export const DISCOVERY_AUTHORITY_ACTIONS = [
  "workfabric.discovery.query.v1",
  "workfabric.discovery.resolve.v1",
  "workfabric.discovery.peer.read.v1",
  "workfabric.discovery.peer.manage.v1",
  "workfabric.discovery.sync.v1",
  "workfabric.discovery.export.v1",
] as const;

export type DiscoveryAuthorityAction =
  (typeof DISCOVERY_AUTHORITY_ACTIONS)[number];

export const DISCOVERY_REQUIRED_STORE_CAPABILITIES = [
  "tenant_view_isolation",
  "monotonic_revisions",
  "retained_tombstones",
  "expiry_filtering",
  "cursor_binding",
  "deterministic_pagination",
  "bounded_capacity",
  "conflicting_replay_rejection",
] as const;
