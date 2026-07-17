import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadNodeConfiguration } from "../src/index.js";

describe("global node configuration", () => {
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
