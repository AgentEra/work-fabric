import type { CapabilityDescriptor } from "@work-fabric/sdk-typescript";

export const DAILY_ASSISTANT_CAPABILITIES: readonly CapabilityDescriptor[] = Object.freeze([
  {
    capability_id: "collaboration.request.intake", version: "1.0.0", name: "Collaboration request intake",
    description: "Normalize an explicitly assigned collaboration request",
    input_media_types: ["text/plain", "text/markdown", "application/json"], output_media_types: ["application/json"],
    input_schema_refs: [], output_schema_refs: [], interaction_modes: ["asynchronous", "status_updates"], constraints: {}, extensions: {},
  },
  {
    capability_id: "information.synthesis", version: "1.0.0", name: "Information synthesis",
    description: "Synthesize content actually supplied and authorized in one Handoff",
    input_media_types: ["text/plain", "text/markdown", "application/json"], output_media_types: ["application/json"],
    input_schema_refs: [], output_schema_refs: [], interaction_modes: ["asynchronous", "status_updates"], constraints: {}, extensions: {},
  },
  {
    capability_id: "collaboration.handoff.draft", version: "1.0.0", name: "Handoff draft",
    description: "Return a downstream Handoff proposal without dispatching it",
    input_media_types: ["text/plain", "text/markdown", "application/json"], output_media_types: ["application/json"],
    input_schema_refs: [], output_schema_refs: [], interaction_modes: ["asynchronous", "status_updates"], constraints: {}, extensions: {},
  },
]);

export const DAILY_ASSISTANT_CAPABILITY_IDS = Object.freeze(
  DAILY_ASSISTANT_CAPABILITIES.map((capability) => capability.capability_id),
);
