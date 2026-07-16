import {
  WAKEUP_TRANSPORT_REQUIRED_CAPABILITIES,
  type ClusterCapabilityManifest,
} from "@work-fabric/cluster-spi";

const manifest: ClusterCapabilityManifest = {
  profile: "workfabric.cluster.v1",
  adapter: "nats-jetstream-wakeup",
  capabilities: Object.fromEntries(
    WAKEUP_TRANSPORT_REQUIRED_CAPABILITIES.map((capability) => [capability, true]),
  ),
};

export function natsWakeupManifest(): ClusterCapabilityManifest {
  return structuredClone(manifest);
}
