import { execFile } from "node:child_process";
import {
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { loadNodeConfiguration } from "../src/index.js";

const execFileAsync = promisify(execFile);

describe("global node configuration", () => {
  it("starts the real SQLite long-connection example from an isolated repository root", async () => {
    const repository = await mkdtemp(join(tmpdir(), "wf-feishu-checkout-"));
    const source = fileURLToPath(new URL(
      "../../../examples/config/service-feishu-long-connection.yaml",
      import.meta.url,
    ));
    const protocol = fileURLToPath(new URL("../../../protocol", import.meta.url));
    const configuration = join(
      repository,
      "examples/config/service-feishu-long-connection.yaml",
    );
    const helper = fileURLToPath(new URL(
      "./helpers/feishu-long-connection-example-start.ts",
      import.meta.url,
    ));
    const tsx = fileURLToPath(new URL(
      "../../../node_modules/tsx/dist/cli.mjs",
      import.meta.url,
    ));

    try {
      await mkdir(join(repository, "examples/config"), { recursive: true });
      await mkdir(join(repository, "var"), { recursive: true });
      await cp(protocol, join(repository, "protocol"), { recursive: true });
      await copyFile(source, configuration);
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [tsx, helper],
        {
          cwd: repository,
          env: {
            PATH: process.env.PATH ?? "",
            WORK_FABRIC_CONFIG: configuration,
            WORK_FABRIC_CURSOR_SECRET: "x".repeat(32),
            FEISHU_APP_ID: "cli_0123456789abcdef",
            FEISHU_APP_SECRET: "synthetic-app-secret",
            FEISHU_CONNECTOR_ACCESS_TOKEN: "synthetic-connector-token",
            INTAKE_AGENT_ACCESS_TOKEN: "synthetic-intake-token",
          },
        },
      );

      expect(stderr).toBe("");
      expect(stdout).toBe('{"started":true}\n');
      const database = await stat(join(repository, "var/work-fabric.db"));
      expect(database.isFile()).toBe(true);
      expect(database.size).toBeGreaterThan(0);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("loads the runnable SQLite Feishu long-connection example with only applicable secrets", async () => {
    const path = fileURLToPath(new URL(
      "../../../examples/config/service-feishu-long-connection.yaml",
      import.meta.url,
    ));
    const loaded = await loadNodeConfiguration({
      WORK_FABRIC_CONFIG: path,
      WORK_FABRIC_CURSOR_SECRET: "x".repeat(32),
      FEISHU_APP_ID: "cli_0123456789abcdef",
      FEISHU_APP_SECRET: "synthetic-app-secret",
      FEISHU_CONNECTOR_ACCESS_TOKEN: "synthetic-connector-token",
      INTAKE_AGENT_ACCESS_TOKEN: "synthetic-intake-token",
    });

    expect(loaded.service).toMatchObject({
      storage_profile: "sqlite-local",
      role: "all",
    });
    const plugin = loaded.plugins["feishu-primary"]?.config;
    expect(plugin).toMatchObject({
      credentials: {
        app_id: "cli_0123456789abcdef",
        app_secret: "synthetic-app-secret",
        work_fabric_access_token: "synthetic-connector-token",
      },
      inbound: { transport: "long_connection" },
    });
    expect(plugin).not.toHaveProperty("credentials.verification_token");
    expect(plugin).not.toHaveProperty("credentials.encrypt_key");
    expect(plugin).not.toHaveProperty("inbound.route_id");
  });

  it("loads service and plugin instances from one YAML Provider with declared environment secrets", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "wf-config-")), "work-fabric.yaml");
    await writeFile(path, `
api_version: workfabric.config/v1
service:
  storage_profile: memory-demo
  role: all
  development_mode: true
  tenant_id: tenant-local
  exchange_id: exchange-local
  cursor_secret: \${CURSOR_SECRET}
  listen: { host: 127.0.0.1, port: 0 }
  identities:
    - authentication_evidence: { bearer_token: "\${HUMAN_TOKEN}" }
      principal:
        principal_id: principal-human
        tenant_id: tenant-local
        actor_claims:
          - actor_id: actor-human
            actor_type: human
            endpoint_ids: [endpoint-human]
        attributes: {}
  authority_rules:
    - tenant_id: tenant-local
      principal_id: principal-human
      actor_id: actor-human
      actor_type: human
      endpoint_id: endpoint-human
      action: workfabric.handoff.offer.v1
      resource_id: null
plugins:
  instances:
    feishu-primary:
      type: collaboration-channel.feishu
      enabled: true
      config:
        connector_id: feishu-primary
        external_tenant_id: tenant-key
        bot_open_id: ou-bot
        credentials:
          app_id: \${FEISHU_APP_ID}
          app_secret: \${FEISHU_APP_SECRET}
          verification_token: \${FEISHU_VERIFY}
          work_fabric_access_token: \${FEISHU_WF_TOKEN}
        inbound:
          enabled: true
          transport: webhook
          route_id: primary
          mention_only: true
          intake_target: { actor_id: actor-agent, endpoint_id: endpoint-agent }
        outbound: { enabled: true, default_render_mode: card, channels: {}, subscriptions: {} }
        identities:
          - { external_open_id: ou-human, actor_id: actor-human, actor_type: human, endpoint_id: endpoint-human }
        worker: { poll_interval_ms: 1000, lease_seconds: 30, batch_limit: 100, max_attempts: 8 }
`, "utf8");
    const loaded = await loadNodeConfiguration({
      WORK_FABRIC_CONFIG: path, CURSOR_SECRET: "x".repeat(32), HUMAN_TOKEN: "human-token",
      FEISHU_APP_ID: "app-id", FEISHU_APP_SECRET: "app-secret", FEISHU_VERIFY: "verify",
      FEISHU_WF_TOKEN: "connector-token",
    });
    expect(loaded.service.cursor_secret).toBe("x".repeat(32));
    expect(loaded.plugins["feishu-primary"]?.config).toMatchObject({ credentials: { app_id: "app-id" } });
    expect(loaded.revision).toMatch(/^sha256:/);
  });

  it("does not resolve or validate a disabled unknown plugin", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "wf-config-disabled-")), "work-fabric.yaml");
    await writeFile(path, `api_version: workfabric.config/v1\nservice:\n  storage_profile: memory-demo\n  development_mode: true\n  tenant_id: tenant-local\n  exchange_id: exchange-local\n  cursor_secret: \${CURSOR_SECRET}\n  identities: [{authentication_evidence: {bearer_token: token}, principal: {principal_id: p, tenant_id: tenant-local, actor_claims: [{actor_id: a, actor_type: human, endpoint_ids: [e]}], attributes: {}}}]\n  authority_rules: [{tenant_id: tenant-local, principal_id: p, actor_id: a, actor_type: human, endpoint_id: e, action: workfabric.operations.health.read.v1, resource_id: null}]\nplugins:\n  instances:\n    future:\n      type: future.channel\n      enabled: false\n      config: {secret: "\${MISSING}"}\n`, "utf8");
    await expect(loadNodeConfiguration({ WORK_FABRIC_CONFIG: path, CURSOR_SECRET: "x".repeat(32) })).resolves.toMatchObject({ plugins: { future: { enabled: false } } });
  });

  it("loads long-connection secrets without a Webhook verification token", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "wf-config-long-connection-")), "work-fabric.yaml");
    await writeFile(path, `
api_version: workfabric.config/v1
service:
  storage_profile: memory-demo
  role: all
  development_mode: true
  tenant_id: tenant-local
  exchange_id: exchange-local
  cursor_secret: \${CURSOR_SECRET}
  listen: { host: 127.0.0.1, port: 0 }
  identities:
    - authentication_evidence: { bearer_token: "\${HUMAN_TOKEN}" }
      principal:
        principal_id: principal-human
        tenant_id: tenant-local
        actor_claims:
          - actor_id: actor-human
            actor_type: human
            endpoint_ids: [endpoint-human]
        attributes: {}
  authority_rules:
    - tenant_id: tenant-local
      principal_id: principal-human
      actor_id: actor-human
      actor_type: human
      endpoint_id: endpoint-human
      action: workfabric.handoff.offer.v1
      resource_id: null
plugins:
  instances:
    feishu-primary:
      type: collaboration-channel.feishu
      enabled: true
      config:
        connector_id: feishu-primary
        external_tenant_id: tenant-key
        bot_open_id: ou-bot
        credentials:
          app_id: \${FEISHU_APP_ID}
          app_secret: \${FEISHU_APP_SECRET}
          work_fabric_access_token: \${FEISHU_WF_TOKEN}
        inbound:
          enabled: true
          transport: long_connection
          mention_only: true
          intake_target: { actor_id: actor-agent, endpoint_id: endpoint-agent }
        outbound: { enabled: true, default_render_mode: card, channels: {}, subscriptions: {} }
        identities:
          - { external_open_id: ou-human, actor_id: actor-human, actor_type: human, endpoint_id: endpoint-human }
        worker: { poll_interval_ms: 1000, lease_seconds: 30, batch_limit: 100, max_attempts: 8 }
`, "utf8");
    const loaded = await loadNodeConfiguration({
      WORK_FABRIC_CONFIG: path,
      CURSOR_SECRET: "x".repeat(32),
      HUMAN_TOKEN: "human-token",
      FEISHU_APP_ID: "app-id",
      FEISHU_APP_SECRET: "app-secret",
      FEISHU_WF_TOKEN: "connector-token",
    });
    expect(loaded.plugins["feishu-primary"]?.config).toMatchObject({
      credentials: { app_id: "app-id", app_secret: "app-secret", work_fabric_access_token: "connector-token" },
      inbound: { transport: "long_connection" },
    });
  });
});
