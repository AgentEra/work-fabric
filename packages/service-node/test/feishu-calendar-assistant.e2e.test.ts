import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  validateRuntimeCapabilitySummaries,
} from "@work-fabric/agent-runtime-spi";
import {
  feishuCalendarCapabilityDeclarations,
  FeishuCapabilitySchemaRegistry,
} from "@work-fabric/provider-feishu";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("Feishu Calendar assistant release contracts", () => {
  it("publishes runtime-safe Calendar schemas including the actual attendee output", async () => {
    const declarations = feishuCalendarCapabilityDeclarations();
    const registry = new FeishuCapabilitySchemaRegistry();
    const signal = new AbortController().signal;
    const summaries = await Promise.all(declarations.map(async (declaration) => ({
      citizen_id: "citizen-feishu-calendar",
      capability_id: declaration.declaration_id,
      version: declaration.version,
      name: declaration.name,
      description: declaration.description,
      operation_kind: declaration.constraints.operation_kind as
        | "query"
        | "command"
        | "destructive",
      input_schema: declaration.input_schema === undefined
        ? null
        : await registry.load(declaration.input_schema, signal),
    })));

    expect(validateRuntimeCapabilitySummaries(summaries)).toHaveLength(7);

    const create = declarations.find((declaration) =>
      declaration.declaration_id === "feishu.calendar.event.create"
    );
    if (create?.output_schema === undefined) {
      throw new Error("Calendar create output schema is missing");
    }
    const output = await registry.load(
      create.output_schema,
      signal,
    ) as {
      readonly required: readonly string[];
      readonly properties: Readonly<Record<string, unknown>>;
    };
    expect(output.required).toContain("attendees");
    expect(output.properties).toHaveProperty("attendees");
  });

  it("keeps every delegated assistant scope within the protocol resource:action grammar", async () => {
    const bundle = parse(await readFile(
      resolve("examples/config/local-feishu-assistant.bundle.yaml"),
      "utf8",
    )) as {
      applications: {
        "work-fabric": {
          plugins: {
            instances: {
              "feishu-primary": {
                config: {
                  inbound: {
                    delegation: { scopes: readonly string[] };
                  };
                };
              };
            };
          };
        };
      };
    };
    const scopes = bundle.applications["work-fabric"].plugins.instances[
      "feishu-primary"
    ].config.inbound.delegation.scopes;

    expect(scopes).toEqual(expect.arrayContaining([
      "conversation_members:read",
      "calendar_freebusy:read",
      "calendar_event:read",
      "calendar_event:write",
      "calendar_attendee:write",
      "calendar_event:delete",
    ]));
    expect(scopes.every((scope) =>
      /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/.test(scope)
    )).toBe(true);
  });
});
