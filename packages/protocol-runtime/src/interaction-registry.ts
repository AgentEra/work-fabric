import { readFile } from "node:fs/promises";

export interface WfppInteractionRegistry {
  readonly spec_version: "1.0";
  readonly mappings: Readonly<Record<string, string>>;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function loadWfppInteractionRegistry(
  path: string,
): Promise<WfppInteractionRegistry> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (
    !isRecord(parsed) ||
    parsed.spec_version !== "1.0" ||
    !isRecord(parsed.mappings)
  ) {
    throw new Error(`Invalid WFPP interaction registry: ${path}`);
  }

  const mappings: Record<string, string> = {};
  for (const [messageType, schemaId] of Object.entries(parsed.mappings)) {
    if (typeof schemaId !== "string" || schemaId.length === 0) {
      throw new Error(
        `Invalid payload Schema mapping for ${messageType}: ${path}`,
      );
    }
    if (messageType === "workfabric.handoff.child_accepted.v1") {
      throw new Error(
        `Internal interaction must not be client-mapped: ${messageType}`,
      );
    }
    mappings[messageType] = schemaId;
  }

  return { spec_version: "1.0", mappings };
}
