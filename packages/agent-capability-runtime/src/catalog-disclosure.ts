import {
  validateRuntimeCapabilitySummaries,
  type CapabilityDisclosurePort,
  type RuntimeCapabilitySummary,
} from "@work-fabric/agent-runtime-spi";

import type { CapabilityDisclosureCatalogClient } from "./contracts.js";

const MAX_SUMMARIES = 32;
const MAX_PAGES = 32;
const NAMESPACE =
  /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*\.$/;

function validateNamespaces(namespaces: readonly string[]): readonly string[] {
  if (
    !Array.isArray(namespaces) ||
    namespaces.length === 0 ||
    namespaces.length > 64 ||
    namespaces.some((namespace) =>
      typeof namespace !== "string" ||
      namespace.length > 128 ||
      !NAMESPACE.test(namespace)
    ) ||
    new Set(namespaces).size !== namespaces.length
  ) {
    throw new TypeError("Capability disclosure namespaces are invalid");
  }
  return namespaces;
}

function allowed(capabilityId: string, namespaces: readonly string[]): boolean {
  return namespaces.some((namespace) => capabilityId.startsWith(namespace));
}

export class CatalogCapabilityDisclosure implements CapabilityDisclosurePort {
  constructor(private readonly catalog: CapabilityDisclosureCatalogClient) {}

  async list(
    namespaces: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly RuntimeCapabilitySummary[]> {
    const allowedNamespaces = validateNamespaces(namespaces);
    const descriptors = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const remaining = MAX_SUMMARIES - descriptors.length;
      if (remaining === 0) {
        throw new RangeError("Capability disclosure Catalog bound exceeded");
      }
      const result = await this.catalog.list({
        citizen_kind: "capability-provider",
        availability: ["available"],
        executable_only: true,
        ...(cursor === undefined ? {} : { cursor }),
        limit: remaining,
      }, { signal });
      if (result.items.length > remaining) {
        throw new RangeError("Capability disclosure Catalog bound exceeded");
      }
      descriptors.push(...result.items);
      if (result.next_cursor === undefined) break;
      cursor = result.next_cursor;
      if (
        descriptors.length === MAX_SUMMARIES ||
        page === MAX_PAGES - 1
      ) {
        throw new RangeError("Capability disclosure Catalog bound exceeded");
      }
    }

    const summaries: RuntimeCapabilitySummary[] = [];
    const identities = new Set<string>();
    for (const descriptor of descriptors) {
      const page = await this.catalog.listDeclarations(
        descriptor.citizen_id,
        { signal },
      );
      for (const declaration of page.items) {
        if (
          declaration.declaration_kind !== "capability" ||
          !allowed(declaration.declaration_id, allowedNamespaces)
        ) {
          continue;
        }
        const identity =
          `${descriptor.citizen_id}\u0000${declaration.declaration_id}\u0000${declaration.version}`;
        if (identities.has(identity)) {
          throw new TypeError("Capability disclosure contains a duplicate");
        }
        identities.add(identity);
        summaries.push({
          citizen_id: descriptor.citizen_id,
          capability_id: declaration.declaration_id,
          version: declaration.version,
          name: declaration.name,
          description: declaration.description,
        });
        if (summaries.length > MAX_SUMMARIES) {
          throw new RangeError("Capability disclosure summary bound exceeded");
        }
      }
    }
    summaries.sort((left, right) =>
      left.capability_id.localeCompare(right.capability_id) ||
      left.citizen_id.localeCompare(right.citizen_id) ||
      left.version.localeCompare(right.version),
    );
    return validateRuntimeCapabilitySummaries(summaries);
  }
}
