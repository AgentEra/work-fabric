import { access, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { LocalAuthorityPolicy } from "@work-fabric/adapter-identity-local";
import { loadAgentRuntimeConfiguration } from "@work-fabric/agent-runtime-host";
import { loadNodeConfiguration } from "@work-fabric/service-node";

const guide = new URL("../../../docs/guides/agently-agent-runtime.md", import.meta.url);
const runtimeYaml = new URL("../../config/agent-runtime-agently.yaml", import.meta.url);
const serviceYaml = new URL("../../config/service-feishu-long-connection.yaml", import.meta.url);
const architecture = new URL("../../../docs/architecture.md", import.meta.url);
const citizenArchitecture = new URL(
  "../../../docs/architecture/network-citizens.md",
  import.meta.url,
);
const channelGuide = new URL(
  "../../../docs/guides/feishu-collaboration-channel.md",
  import.meta.url,
);
const providerGuide = new URL(
  "../../../docs/guides/feishu-capability-provider.md",
  import.meta.url,
);
const localBundle = new URL(
  "../../config/local-feishu-assistant.bundle.yaml",
  import.meta.url,
);
const dailyAssistantDriver = new URL(
  "../src/daily-assistant-driver.ts",
  import.meta.url,
);
const contextPreflightPolicy = new URL(
  "../src/context-preflight-policy.ts",
  import.meta.url,
);

describe("Agently Runtime operator guide", () => {
  it("documents the supported absolute environment contract and separate process startup", async () => {
    const source = await readFile(guide, "utf8");

    expect(source).toContain('export WORK_FABRIC_CONFIG="$REPOSITORY_ROOT/examples/config/service-feishu-long-connection.yaml"');
    expect(source).toContain('export WORK_FABRIC_AGENT_RUNTIME_CONFIG="$REPOSITORY_ROOT/examples/config/agent-runtime-agently.yaml"');
    expect(source).toContain("### Terminal 1 — Service");
    expect(source).toContain("### Terminal 2 — Runtime");
    expect(source).not.toContain("--config");
    expect(source).not.toContain("WF_BASE_URL=");
    expect(source).not.toContain("WF_ACCESS_TOKEN=");
    for (const name of [
      "WORK_FABRIC_AGENT_RUNTIME_CONFIG",
      "INTAKE_AGENT_ACCESS_TOKEN",
      "AGENTLY_MODEL_API_KEY",
    ]) expect(source).toContain(name);
  });

  it("documents exactly the environment placeholders consumed by the Runtime YAML loader", async () => {
    const [source, yaml] = await Promise.all([readFile(guide, "utf8"), readFile(runtimeYaml, "utf8")]);
    expect(yaml).toContain("${INTAKE_AGENT_ACCESS_TOKEN}");
    expect(yaml).toContain("${AGENTLY_MODEL_API_KEY}");
    const loaded = await loadAgentRuntimeConfiguration({
      WORK_FABRIC_AGENT_RUNTIME_CONFIG: runtimeYaml.pathname,
      INTAKE_AGENT_ACCESS_TOKEN: "runtime-contract-token",
      AGENTLY_MODEL_API_KEY: "model-contract-token",
    });

    expect(loaded.service.work_fabric.access_token).toBe("runtime-contract-token");
    expect(loaded.driver.config.provider.api_key).toBe("model-contract-token");
    expect(source).toContain("INTAKE_AGENT_ACCESS_TOKEN");
    expect(source).toContain("AGENTLY_MODEL_API_KEY");
  });

  it("uses one ignored environment file whose intake token is shared by Service and Runtime", async () => {
    const source = await readFile(guide, "utf8");
    const shared = {
      WORK_FABRIC_CONFIG: serviceYaml.pathname,
      WORK_FABRIC_AGENT_RUNTIME_CONFIG: runtimeYaml.pathname,
      WORK_FABRIC_CURSOR_SECRET: "x".repeat(32),
      WORK_FABRIC_ADMISSION_FINGERPRINT_KEY: "f".repeat(32),
      WORK_FABRIC_ADMISSION_GRANT_KEY: "g".repeat(32),
      WORK_FABRIC_ADMIN_TOKEN: "admin-contract-token",
      INTAKE_AGENT_ACCESS_TOKEN: "shared-intake-contract-token",
      FEISHU_APP_ID: "cli_0123456789abcdef",
      FEISHU_APP_SECRET: "feishu-contract-secret",
      FEISHU_CONNECTOR_ACCESS_TOKEN: "connector-contract-token",
      AGENTLY_MODEL_API_KEY: "model-contract-token",
    };

    const [service, runtime] = await Promise.all([
      loadNodeConfiguration(shared),
      loadAgentRuntimeConfiguration(shared),
    ]);
    const intakeIdentity = service.service.identities.find((identity) =>
      identity.principal.principal_id === "principal-intake-agent"
    );
    expect(intakeIdentity?.authentication_evidence.bearer_token).toBe("shared-intake-contract-token");
    expect(runtime.service.work_fabric.access_token).toBe("shared-intake-contract-token");
    expect(source).toContain('WORK_FABRIC_SHARED_ENV="$HOME/.config/work-fabric/agently-daily-assistant.env"');
    expect(source.match(/WORK_FABRIC_SHARED_ENV="\$HOME\/\.config\/work-fabric\/agently-daily-assistant\.env"/g)).toHaveLength(3);
    expect(source.match(/source "\$WORK_FABRIC_SHARED_ENV"/g)).toHaveLength(3);
    expect(source).not.toContain('export INTAKE_AGENT_ACCESS_TOKEN="$(openssl rand');
  });

  it("describes the Console Operations Delivery view without claiming unavailable raw cursor details", async () => {
    const source = await readFile(guide, "utf8");

    expect(source).toContain("Console **Operations → Deliveries**");
    expect(source).toContain("does **not** expose raw subscription cursors or Delivery/Status/Result payload bodies");
  });

  it("documents independent Provider facets and Agent-driven context retrieval", async () => {
    const [root, citizens, channel, provider] = await Promise.all([
      readFile(architecture, "utf8"),
      readFile(citizenArchitecture, "utf8"),
      readFile(channelGuide, "utf8"),
      readFile(providerGuide, "utf8"),
    ]);
    const guides = `${channel}\n${provider}`;
    for (const term of [
      "feishu.conversation.history.read",
      "agent_managed",
      "WORK_FABRIC_FEISHU_CURSOR_SECRET",
      "query capability",
      "Feishu Message Provider",
      "Feishu Document Provider",
    ]) {
      expect(guides).toContain(term);
    }
    expect(`${root}\n${citizens}`).toContain(
      "Integration is not a Citizen or runtime",
    );
    expect(`${root}\n${citizens}`).toContain(
      "Provider facets do not depend on Channel facets",
    );
  });

  it("documents model-owned progressive retrieval for implicit conversation references", async () => {
    const source = await readFile(guide, "utf8");
    const prose = source.replace(/\s+/gu, " ");

    for (const term of [
      "does not replay messages sent while the Service is offline",
      "结构化上下文充分性判断",
      "禁止用关键词或正则表达式",
      "报错的详细信息",
      "current Handoff intent authorizes",
      "has_more",
    ]) expect(prose).toContain(term);
  });

  it("forbids deterministic natural-language intent classification", async () => {
    await expect(access(contextPreflightPolicy)).rejects.toThrow();
    const [driver, architectureSource] = await Promise.all([
      readFile(dailyAssistantDriver, "utf8"),
      readFile(architecture, "utf8"),
    ]);
    expect(driver).not.toMatch(
      /ContextPreflightPolicy|explicitlyDependsOnEarlierContext|explicitProposalCancellation|intentText/,
    );
    expect(architectureSource).toContain(
      "禁止用关键词、正则表达式或固定自然语言词表",
    );
  });

  it("configures the Calendar Citizen and least-privilege scheduling delegation", async () => {
    const source = await readFile(localBundle, "utf8");
    for (const value of [
      "calendar_citizen:",
      "citizen_id: citizen-feishu-calendar",
      "resource_id: citizen-feishu-calendar",
      "conversation_members:read",
      "calendar_freebusy:read",
      "calendar_event:read",
      "calendar_event:write",
      "calendar_attendee:write",
      "calendar_event:delete",
      "citizen-feishu-calendar/feishu.calendar.events.list",
    ]) expect(source).toContain(value);
    expect(source).not.toMatch(/calendar_(?:id|ids):/);
  });

  it("allows the Daily Assistant to progressively disclose the GitHub Citizen summary", async () => {
    const bundle = parse(await readFile(localBundle, "utf8")) as {
      applications: {
        "work-fabric": {
          service: {
            identities: Array<{
              principal: {
                principal_id: string;
                tenant_id: string;
                actor_claims: Array<{
                  actor_id: string;
                  actor_type: "human" | "agent" | "system";
                  endpoint_ids: string[];
                }>;
                attributes: Record<string, unknown>;
              };
            }>;
            authority_rules: ConstructorParameters<typeof LocalAuthorityPolicy>[0];
          };
        };
      };
    };
    const service = bundle.applications["work-fabric"].service;
    const principal = service.identities.find(
      (identity) => identity.principal.principal_id === "principal-intake-agent",
    )?.principal;
    expect(principal).toBeDefined();

    await expect(new LocalAuthorityPolicy(service.authority_rules).authorize({
      principal: principal!,
      actor_id: "actor-intake-agent",
      actor_type: "agent",
      endpoint_id: "endpoint-intake-agent",
      action: "workfabric.citizen.declaration-summary.read.v1",
      resource_id: "citizen-github-read",
    })).resolves.toEqual({ kind: "allow" });
  });
});
