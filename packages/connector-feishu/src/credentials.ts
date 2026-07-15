export interface FeishuWebhookCredentials {
  readonly verification_token: string;
  readonly encrypt_key?: string;
}

export interface FeishuCredentialProvider {
  loadWebhookCredentials(
    credentialReference: string,
  ): Promise<FeishuWebhookCredentials>;
}

export function assertFeishuWebhookCredentials(
  credentials: FeishuWebhookCredentials,
): void {
  if (
    typeof credentials.verification_token !== "string" ||
    credentials.verification_token.length === 0
  ) {
    throw new TypeError("Feishu verification credential is required");
  }
  if (
    credentials.encrypt_key !== undefined &&
    credentials.encrypt_key.length === 0
  ) {
    throw new TypeError("Feishu encryption credential cannot be empty");
  }
}
