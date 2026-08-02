import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

import { GitHubProviderError } from "@work-fabric/provider-github";

export interface GitHubAppCredentials {
  readonly app_id: string;
  readonly installation_id: string;
  readonly private_key: string;
}

export interface GitHubCredentialProvider {
  load(): Promise<GitHubAppCredentials>;
}

export interface OctokitRequestClient {
  request: Octokit["request"];
}

export interface GitHubAppOctokitOptions {
  readonly authStrategy: typeof createAppAuth;
  readonly auth: {
    readonly appId: string;
    readonly privateKey: string;
    readonly installationId: string;
  };
}

export type GitHubAppOctokitFactory = (
  options: GitHubAppOctokitOptions,
) => OctokitRequestClient;

function invalidCredentials(): never {
  throw new GitHubProviderError("github_invalid_request");
}

function isDecimalIdentifier(value: string): boolean {
  return /^\d+$/.test(value);
}

function isPrivateKeyPem(value: string): boolean {
  return /^-----BEGIN (?:RSA )?PRIVATE KEY-----\r?\n[\s\S]+\r?\n-----END (?:RSA )?PRIVATE KEY-----\r?\n?$/.test(value);
}

function validateCredentials(credentials: GitHubAppCredentials): void {
  if (
    !isDecimalIdentifier(credentials.app_id) ||
    !isDecimalIdentifier(credentials.installation_id) ||
    !isPrivateKeyPem(credentials.private_key)
  ) invalidCredentials();
}

export function createGitHubAppOctokit(
  credentials: GitHubAppCredentials,
  factory: GitHubAppOctokitFactory = (options) => new Octokit(options),
): OctokitRequestClient {
  validateCredentials(credentials);
  return factory({
    authStrategy: createAppAuth,
    auth: {
      appId: credentials.app_id,
      privateKey: credentials.private_key,
      installationId: credentials.installation_id,
    },
  });
}
