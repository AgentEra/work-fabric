import { describe, expect, it } from "vitest";

import { EnvironmentGitHubCredentialProvider } from "../src/credentials.js";

describe("EnvironmentGitHubCredentialProvider", () => {
  it("loads only one configured GitHub App credential from configured environment names", async () => {
    const provider = new EnvironmentGitHubCredentialProvider({
      credential_ref: "github-primary",
      app_id_environment: "APP_ID",
      installation_id_environment: "INSTALLATION_ID",
      private_key_environment: "PRIVATE_KEY",
      environment: {
        APP_ID: "123",
        INSTALLATION_ID: "456",
        PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nYWJj\n-----END PRIVATE KEY-----\n",
      },
    });
    await expect(provider.load()).resolves.toEqual({
      app_id: "123",
      installation_id: "456",
      private_key: "-----BEGIN PRIVATE KEY-----\nYWJj\n-----END PRIVATE KEY-----\n",
    });
  });

  it("does not fall back to PAT environment variables", async () => {
    const provider = new EnvironmentGitHubCredentialProvider({
      credential_ref: "github-primary",
      app_id_environment: "APP_ID",
      installation_id_environment: "INSTALLATION_ID",
      private_key_environment: "PRIVATE_KEY",
      environment: { GITHUB_TOKEN: "ghp_not-supported" },
    });
    await expect(provider.load()).rejects.toThrow("GitHub App credentials are unavailable");
  });
});
