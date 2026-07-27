import {
  validateCapabilityCandidate,
  type CapabilityCandidate,
  type CapabilityRequirement,
} from "@work-fabric/agent-runtime-spi";
import { canonicalCitizenDigest } from "@work-fabric/network-citizen-spi";

import type { CapabilityCatalogClient } from "./contracts.js";

const CAPABILITY_ID = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_PAGES = 10;

function constraint(value: string): {
  readonly kind: "any" | "exact" | "compatible";
  readonly version?: string;
} {
  if (value === "*") return { kind: "any" };
  if (SEMVER.test(value)) return { kind: "exact", version: value };
  if (value.startsWith("^") && SEMVER.test(value.slice(1))) {
    return { kind: "compatible", version: value.slice(1) };
  }
  throw new TypeError("version_constraint is invalid");
}

function matches(
  version: string,
  expected: ReturnType<typeof constraint>,
): boolean {
  if (!SEMVER.test(version)) return false;
  if (expected.kind === "any") return true;
  if (expected.kind === "exact") return version === expected.version;
  const actualParts = version.split(".").map(Number);
  const expectedParts = expected.version!.split(".").map(Number);
  const actualMajor = actualParts[0]!;
  const expectedMajor = expectedParts[0]!;
  if (actualMajor !== expectedMajor) return false;
  if (expectedMajor > 0) return true;
  const actualMinor = actualParts[1]!;
  const expectedMinor = expectedParts[1]!;
  return actualMinor === expectedMinor && actualParts[2]! >= expectedParts[2]!;
}

function options(signal: AbortSignal | undefined) {
  return signal === undefined ? {} : { signal };
}

export class CatalogCapabilityResolver {
  constructor(private readonly catalog: CapabilityCatalogClient) {}

  async discover(
    requirement: CapabilityRequirement,
    signal?: AbortSignal,
  ): Promise<readonly CapabilityCandidate[]> {
    if (
      !CAPABILITY_ID.test(requirement.capability_id) ||
      requirement.capability_id.length > 128
    ) {
      throw new TypeError("capability_id is invalid");
    }
    const expected = constraint(requirement.version_constraint);
    const descriptors = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.catalog.list({
        citizen_kind: "capability-provider",
        declaration_id: requirement.capability_id,
        availability: ["available", "degraded"],
        executable_only: true,
        ...(cursor === undefined ? {} : { cursor }),
        limit: 100,
      }, options(signal));
      descriptors.push(...result.items);
      if (result.next_cursor === undefined) break;
      cursor = result.next_cursor;
      if (page === MAX_PAGES - 1) {
        throw new Error("Citizen Catalog pagination exceeded its bound");
      }
    }

    const candidates: CapabilityCandidate[] = [];
    for (const descriptor of descriptors.sort((left, right) =>
      left.citizen_id.localeCompare(right.citizen_id),
    )) {
      const endpointId = descriptor.identity?.endpoint_id;
      if (endpointId === undefined) continue;
      const contract = await this.catalog.getDeclaration(
        descriptor.citizen_id,
        requirement.capability_id,
        options(signal),
      );
      if (
        contract.citizen_id !== descriptor.citizen_id ||
        contract.citizen_kind !== "capability-provider" ||
        !["available", "degraded"].includes(contract.availability) ||
        contract.declaration.declaration_kind !== "capability" ||
        contract.declaration.declaration_id !== requirement.capability_id ||
        !matches(contract.declaration.version, expected)
      ) continue;
      candidates.push(validateCapabilityCandidate({
        citizen_id: descriptor.citizen_id,
        endpoint_id: endpointId,
        capability_id: contract.declaration.declaration_id,
        capability_version: contract.declaration.version,
        contract_digest: canonicalCitizenDigest(contract.declaration),
      }));
    }
    return Object.freeze(candidates);
  }
}
