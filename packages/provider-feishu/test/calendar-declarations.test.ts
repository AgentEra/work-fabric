import { describe, expect, it } from "vitest";

import {
  FeishuCapabilitySchemaRegistry,
  feishuCapabilityDeclarations,
} from "../src/index.js";
import * as provider from "../src/index.js";

type DeclarationFactory = () => readonly {
  readonly declaration_id: string;
  readonly version: string;
  readonly risk: string;
  readonly confirmation: string;
  readonly constraints: Record<string, unknown>;
  readonly input_schema?: {
    readonly uri: string;
    readonly digest: `sha256:${string}`;
  };
}[];

function declarations(): ReturnType<DeclarationFactory> | undefined {
  const factory = (provider as Record<string, unknown>)[
    "feishuCalendarCapabilityDeclarations"
  ];
  return typeof factory === "function"
    ? (factory as DeclarationFactory)()
    : undefined;
}

describe("Feishu Calendar capability declarations", () => {
  it("publishes seven independent typed-facts-only Calendar contracts", () => {
    expect(declarations()?.map((item) => item.declaration_id)).toEqual([
      "feishu.calendar.attendees.add",
      "feishu.calendar.attendees.remove",
      "feishu.calendar.event.create",
      "feishu.calendar.event.delete",
      "feishu.calendar.event.read",
      "feishu.calendar.event.update",
      "feishu.calendar.freebusy.query",
    ]);
    expect(declarations()?.map((item) => ({
      id: item.declaration_id,
      version: item.version,
      risk: item.risk,
      operation: item.constraints.operation_kind,
      confirmation: item.confirmation,
      output: item.constraints.provider_output,
    }))).toEqual([
      {
        id: "feishu.calendar.attendees.add",
        version: "1.0.0",
        risk: "medium",
        operation: "command",
        confirmation: "none",
        output: "typed_facts_only",
      },
      {
        id: "feishu.calendar.attendees.remove",
        version: "1.0.0",
        risk: "medium",
        operation: "command",
        confirmation: "none",
        output: "typed_facts_only",
      },
      {
        id: "feishu.calendar.event.create",
        version: "1.0.0",
        risk: "medium",
        operation: "command",
        confirmation: "none",
        output: "typed_facts_only",
      },
      {
        id: "feishu.calendar.event.delete",
        version: "1.0.0",
        risk: "destructive",
        operation: "destructive",
        confirmation: "explicit",
        output: "typed_facts_only",
      },
      {
        id: "feishu.calendar.event.read",
        version: "1.0.0",
        risk: "low",
        operation: "query",
        confirmation: "none",
        output: "typed_facts_only",
      },
      {
        id: "feishu.calendar.event.update",
        version: "1.0.0",
        risk: "medium",
        operation: "command",
        confirmation: "none",
        output: "typed_facts_only",
      },
      {
        id: "feishu.calendar.freebusy.query",
        version: "1.0.0",
        risk: "low",
        operation: "query",
        confirmation: "none",
        output: "typed_facts_only",
      },
    ]);
  });

  it("loads Calendar schemas without changing existing aggregate contracts", async () => {
    const calendar = declarations();
    expect(calendar).toBeDefined();
    const registry = new FeishuCapabilitySchemaRegistry();
    await expect(registry.load(
      calendar![0]!.input_schema!,
      new AbortController().signal,
    )).resolves.toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    expect(feishuCapabilityDeclarations().map((item) =>
      item.declaration_id
    )).not.toContain("feishu.calendar.event.create");
  });
});
