import type { GitHubAppCredentials, GitHubCredentialProvider } from "@work-fabric/adapter-github-octokit";

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
      private_key: privateKey,
    });
  }
}
