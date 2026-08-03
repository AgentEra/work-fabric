import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createGitHubAppOctokit,
  type GitHubAppOctokitOptions,
  type OctokitRequestClient,
} from "@work-fabric/adapter-github-octokit";

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

  it("decodes a strict base64 .env value into a parseable GitHub App PEM", async () => {
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2_048 }).privateKey.export({
      type: "pkcs8",
      format: "pem",
    }).toString();
    const provider = new EnvironmentGitHubCredentialProvider({
      credential_ref: "github-primary",
      app_id_environment: "APP_ID",
      installation_id_environment: "INSTALLATION_ID",
      private_key_environment: "PRIVATE_KEY",
      environment: {
        APP_ID: "123",
        INSTALLATION_ID: "456",
        PRIVATE_KEY: `base64:${Buffer.from(privateKey, "utf8").toString("base64")}`,
      },
    });

    const credentials = await provider.load();
    const observed: GitHubAppOctokitOptions[] = [];
    expect(() => createGitHubAppOctokit(credentials, (options) => {
      observed.push(options);
      return { request: async () => ({ data: {}, headers: {} }) } as unknown as OctokitRequestClient;
    })).not.toThrow();
    expect(observed[0]?.auth.privateKey).toBe(privateKey);
  });

  it.each([
    ["invalid alphabet", "base64:not/base64="],
    ["missing padding", "base64:YWJjZA"],
    ["decoded NUL", `base64:${Buffer.from("private\0key", "utf8").toString("base64")}`],
    ["decoded size overflow", `base64:${Buffer.alloc(65_537, 97).toString("base64")}`],
    ["raw NUL", "raw\0private-key"],
  ])("rejects an invalid or unsafe private key without echoing it: %s", async (_name, privateKey) => {
    const provider = new EnvironmentGitHubCredentialProvider({
      credential_ref: "github-primary",
      app_id_environment: "APP_ID",
      installation_id_environment: "INSTALLATION_ID",
      private_key_environment: "PRIVATE_KEY",
      environment: {
        APP_ID: "123",
        INSTALLATION_ID: "456",
        PRIVATE_KEY: privateKey,
      },
    });

    await expect(provider.load()).rejects.toThrow("GitHub App credentials are invalid");
  });
});
