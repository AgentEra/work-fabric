import { describe, expect, it } from "vitest";
import { FeishuWebhookRegistry } from "../src/index.js";

describe("FeishuWebhookRegistry", () => {
  it("registers isolated instance bindings without exposing credentials in resolution", async () => {
    const registry = new FeishuWebhookRegistry();
    registry.register("feishu-a", { tenant_id: "tenant-a", connector_id: "feishu-a", external_tenant_id: "tk-a", credential_ref: "ref-a", credentials: { verification_token: "secret-a" } });
    expect(await registry.resolve("feishu-a")).toEqual({ route_connector_id: "feishu-a", tenant_id: "tenant-a", connector_id: "feishu-a", external_tenant_id: "tk-a", credential_ref: "ref-a" });
    expect(await registry.loadWebhookCredentials("ref-a")).toEqual({ verification_token: "secret-a" });
    registry.unregister("feishu-a");
    await expect(registry.resolve("feishu-a")).resolves.toBeNull();
  });
  it("rejects duplicate connector and credential scopes", () => {
    const registry = new FeishuWebhookRegistry();
    const value = { tenant_id: "tenant", connector_id: "feishu", external_tenant_id: "tk", credential_ref: "ref", credentials: { verification_token: "secret" } };
    registry.register("one", value);
    expect(() => registry.register("two", value)).toThrow(/duplicate/);
  });
});
