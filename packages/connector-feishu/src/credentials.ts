export interface FeishuWebhookCredentials {
  readonly verification_token: string;
  readonly encrypt_key?: string;
}

export interface FeishuCredentialProvider {
  loadWebhookCredentials(
    credentialReference: string,
  ): Promise<FeishuWebhookCredentials>;
}

export interface FeishuAppCredentials {
  readonly app_id: string;
  readonly app_secret: string;
}

export interface FeishuAppCredentialProvider {
  loadAppCredentials(
    credentialReference: string,
  ): Promise<FeishuAppCredentials>;
}

export function assertFeishuAppCredentials(
  credentials: FeishuAppCredentials,
): void {
  if (
    typeof credentials.app_id !== "string" ||
    credentials.app_id.length === 0 ||
    typeof credentials.app_secret !== "string" ||
    credentials.app_secret.length === 0
  ) {
    throw new TypeError("Feishu application credentials are invalid");
  }
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
