import type {
  ConnectorIdentityQuery,
  ConnectorIdentityResolver,
  ConnectorResolvedIdentity,
} from "@work-fabric/connector-spi";

export type FeishuIdentityLookup = (
  query: ConnectorIdentityQuery,
) => Promise<ConnectorResolvedIdentity | null>;

function bounded(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    value.trim() !== value
  ) {
    throw new TypeError(`${label} must be a bounded non-empty string`);
  }
}

function validateQuery(query: ConnectorIdentityQuery): void {
  bounded(query.tenant_id, "tenant_id");
  bounded(query.connector_id, "connector_id");
  bounded(query.source_system, "source_system");
  bounded(query.external_tenant_id, "external_tenant_id");
  bounded(query.external_subject_type, "external_subject_type");
  bounded(query.external_subject_id, "external_subject_id");
}

export class FeishuIdentityMapper implements ConnectorIdentityResolver {
  readonly manifest = {
    profile: "connector.identity.v1",
    adapter: "feishu",
    capabilities: {
      explicit_mapping: true,
      tenant_isolation: true,
      no_implicit_provisioning: true,
    },
  } as const;

  constructor(private readonly lookup: FeishuIdentityLookup) {}

  async resolve(
    query: ConnectorIdentityQuery,
  ): Promise<ConnectorResolvedIdentity | null> {
    validateQuery(query);
    if (query.source_system !== "feishu") return null;
    const resolved = await this.lookup(structuredClone(query));
    if (resolved === null) return null;
    bounded(resolved.actor_id, "actor_id");
    if (
      resolved.actor_type !== "human" &&
      resolved.actor_type !== "agent" &&
      resolved.actor_type !== "system"
    ) {
      throw new TypeError("actor_type is invalid");
    }
    if (resolved.endpoint_id !== undefined) {
      bounded(resolved.endpoint_id, "endpoint_id");
    }
    if (resolved.delegation_id !== undefined) {
      bounded(resolved.delegation_id, "delegation_id");
    }
    return structuredClone(resolved);
  }
}
