import type { GitHubAppCredentials, GitHubCredentialProvider } from "@work-fabric/adapter-github-octokit";

const BASE64_PREFIX = "base64:";
const MAX_PRIVATE_KEY_BYTES = 65_536;
const strictBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function invalidCredentials(): never {
  throw new Error("GitHub App credentials are invalid");
}

function checkedPrivateKey(value: string): string {
  let result = value;
  if (value.startsWith(BASE64_PREFIX)) {
    const encoded = value.slice(BASE64_PREFIX.length);
    if (
      encoded.length === 0 ||
      encoded.length > Math.ceil(MAX_PRIVATE_KEY_BYTES / 3) * 4 ||
      encoded.length % 4 !== 0 ||
      !strictBase64.test(encoded)
    ) invalidCredentials();
    const decoded = Buffer.from(encoded, "base64");
    if (
      decoded.byteLength > MAX_PRIVATE_KEY_BYTES ||
      decoded.toString("base64") !== encoded
    ) invalidCredentials();
    try {
      result = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
    } catch {
      invalidCredentials();
    }
  }
  if (
    Buffer.byteLength(result, "utf8") > MAX_PRIVATE_KEY_BYTES ||
    result.includes("\0")
  ) invalidCredentials();
  return result;
}

export interface EnvironmentGitHubCredentialProviderOptions {
  readonly credential_ref: string;
  readonly app_id_environment: string;
  readonly installation_id_environment: string;
  readonly private_key_environment: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

/** Loads App-only credentials at client construction; it never falls back to a PAT. */
export class EnvironmentGitHubCredentialProvider implements GitHubCredentialProvider {
  constructor(private readonly options: EnvironmentGitHubCredentialProviderOptions) {
    for (const value of [
      options.credential_ref,
      options.app_id_environment,
      options.installation_id_environment,
      options.private_key_environment,
    ]) {
      if (value.length === 0) throw new TypeError("GitHub credential configuration is invalid");
    }
  }

  async load(): Promise<GitHubAppCredentials> {
    const appId = this.options.environment[this.options.app_id_environment];
    const installationId = this.options.environment[this.options.installation_id_environment];
    const privateKey = this.options.environment[this.options.private_key_environment];
    if (
      appId === undefined || appId.length === 0 ||
      installationId === undefined || installationId.length === 0 ||
      privateKey === undefined || privateKey.length === 0
    ) {
      throw new Error("GitHub App credentials are unavailable");
    }
    return Object.freeze({
      app_id: appId,
      installation_id: installationId,
      private_key: checkedPrivateKey(privateKey),
    });
  }
}
