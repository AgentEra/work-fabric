import type {
  FeishuAppCredentialProvider,
  FeishuAppCredentials,
} from "@work-fabric/connector-feishu";

export interface EnvironmentFeishuAppCredentialProviderOptions {
  readonly credential_ref: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export class EnvironmentFeishuAppCredentialProvider
  implements FeishuAppCredentialProvider {
  constructor(
    private readonly options: EnvironmentFeishuAppCredentialProviderOptions,
  ) {
    if (options.credential_ref.length === 0) {
      throw new TypeError("credential reference is invalid");
    }
  }

  async loadAppCredentials(
    credentialReference: string,
  ): Promise<FeishuAppCredentials> {
    if (credentialReference !== this.options.credential_ref) {
      throw new Error("credential reference is unavailable");
    }
    const appId = this.options.environment.FEISHU_APP_ID;
    const appSecret = this.options.environment.FEISHU_APP_SECRET;
    if (
      appId === undefined ||
      appId.length === 0 ||
      appSecret === undefined ||
      appSecret.length === 0
    ) {
      throw new Error("Feishu application credentials are unavailable");
    }
    return Object.freeze({ app_id: appId, app_secret: appSecret });
  }
}
