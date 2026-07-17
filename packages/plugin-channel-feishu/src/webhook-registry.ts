import type { FeishuWebhookCredentials } from "@work-fabric/connector-feishu";

export interface FeishuWebhookRegistration {
  readonly tenant_id: string; readonly connector_id: string; readonly external_tenant_id: string;
  readonly credential_ref: string; readonly credentials: FeishuWebhookCredentials;
}
export interface FeishuWebhookBinding {
  readonly route_connector_id: string; readonly tenant_id: string; readonly connector_id: string;
  readonly external_tenant_id: string; readonly credential_ref: string;
}

export class FeishuWebhookRegistry {
  private readonly byConnector = new Map<string, { instanceId: string; registration: FeishuWebhookRegistration }>();
  private readonly byCredential = new Map<string, { instanceId: string; credentials: FeishuWebhookCredentials }>();
  register(instanceId: string, registration: FeishuWebhookRegistration): void {
    if (this.byConnector.has(registration.connector_id) || this.byCredential.has(registration.credential_ref)) throw new Error("duplicate_feishu_webhook_scope");
    this.byConnector.set(registration.connector_id, { instanceId, registration: structuredClone(registration) });
    this.byCredential.set(registration.credential_ref, { instanceId, credentials: structuredClone(registration.credentials) });
  }
  unregister(instanceId: string): void {
    for (const [key, value] of this.byConnector) if (value.instanceId === instanceId) this.byConnector.delete(key);
    for (const [key, value] of this.byCredential) if (value.instanceId === instanceId) this.byCredential.delete(key);
  }
  async resolve(connectorId: string): Promise<FeishuWebhookBinding | null> {
    const entry = this.byConnector.get(connectorId); if (entry === undefined) return null;
    const value = entry.registration;
    return { route_connector_id: value.connector_id, tenant_id: value.tenant_id, connector_id: value.connector_id, external_tenant_id: value.external_tenant_id, credential_ref: value.credential_ref };
  }
  async loadWebhookCredentials(credentialReference: string): Promise<FeishuWebhookCredentials> {
    const value = this.byCredential.get(credentialReference);
    if (value === undefined) throw new Error("feishu_webhook_credential_unavailable");
    return structuredClone(value.credentials);
  }
}
