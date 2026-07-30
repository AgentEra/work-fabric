import { describe, expect, it } from "vitest";

import {
  FeishuCapabilitySchemaRegistry,
  feishuCapabilityDeclarations,
} from "../src/index.js";
import { JsonSchemaInvocationValidator } from "@work-fabric/agent-capability-runtime";
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
  readonly output_schema?: {
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

  it("accepts the typed event facts returned by a successful real create", async () => {
    const declaration = declarations()?.find((item) =>
      item.declaration_id === "feishu.calendar.event.create"
    );
    expect(declaration?.output_schema).toBeDefined();
    const registry = new FeishuCapabilitySchemaRegistry();
    const validator = new JsonSchemaInvocationValidator(registry);

    await expect(validator.validateOutput({
      candidate: {
        citizen_id: "citizen-feishu-calendar",
        endpoint_id: "endpoint-feishu-provider",
        capability_id: "feishu.calendar.event.create",
        capability_version: "1.0.0",
        contract_digest: `sha256:${"a".repeat(64)}`,
      },
      input_schema: declaration!.input_schema!,
      output_schema: declaration!.output_schema!,
      confirmation: "none",
      risk: "medium",
      operation_kind: "command",
    }, {
      event_resource_uri:
        "feishu://calendar/cal-team/events/event-1",
      calendar_resource_uri: "feishu://calendar/cal-team",
      event_id: "event-1",
      title: "Work Fabric 真实日历烟测",
      description: "",
      start_at: "2026-07-31T08:00:00.000Z",
      end_at: "2026-07-31T08:30:00.000Z",
      time_zone: "Asia/Shanghai",
      visibility: "default",
      organizer_mode: "application",
      attendees: [],
      provider_version: 1,
      url: "https://applink.feishu.cn/client/calendar/event/detail",
      provenance: {
        provider_family: "feishu",
        source: "feishu.calendar.event",
      },
      attendee_outcomes: [],
      completion_state: "complete",
    }, [], new AbortController().signal)).resolves.toMatchObject({
      data: {
        title: "Work Fabric 真实日历烟测",
        visibility: "default",
        completion_state: "complete",
      },
    });
  });
});
