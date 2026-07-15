export interface FeishuWebhookLimits {
  readonly max_body_bytes: number;
  readonly max_clock_skew_seconds: number;
  readonly max_json_depth: number;
}

export interface FeishuIngressScope {
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly expected_external_tenant_id: string;
  readonly received_at: string;
}

export function assertFeishuWebhookLimits(limits: FeishuWebhookLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
}
