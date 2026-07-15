export interface CapabilityManifest {
  readonly profile: string;
  readonly adapter: string;
  readonly capabilities: Readonly<Record<string, boolean>>;
}

export type CapabilityRequirement = readonly string[];

export interface ExchangeAdapter {
  readonly manifest: CapabilityManifest;
}

export function assertCapabilities(
  manifest: CapabilityManifest,
  required: CapabilityRequirement,
): void {
  for (const capability of required) {
    if (manifest.capabilities[capability] !== true) {
      throw new Error(`Missing required capability: ${capability}`);
    }
  }
}
