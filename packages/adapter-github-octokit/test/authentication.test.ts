import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createGitHubAppOctokit,
  type GitHubAppOctokitOptions,
  type GitHubAppCredentials,
  type OctokitRequestClient,
} from "../src/index.js";

const validPrivateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs8",
  format: "pem",
}).toString();

const credentials: GitHubAppCredentials = {
  app_id: "12345",
  installation_id: "67890",
  private_key: validPrivateKey,
};

describe("GitHub App authentication", () => {
  it("constructs an installation-authenticated client", () => {
    const observed: GitHubAppOctokitOptions[] = [];

    createGitHubAppOctokit(credentials, (options) => {
      observed.push(options);
      return { request: async () => ({ data: {}, headers: {} }) } as unknown as OctokitRequestClient;
    });

    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      auth: { appId: "12345", installationId: "67890" },
    });
  });

  it.each([
    "-----BEGIN PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----",
    "-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
    "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
  ])("rejects a mismatched or repeated private-key envelope", (private_key) => {
    let constructions = 0;

    expect(() => createGitHubAppOctokit({ ...credentials, private_key }, () => {
      constructions += 1;
      return { request: async () => ({ data: {}, headers: {} }) } as unknown as OctokitRequestClient;
    })).toThrowError("github_invalid_request");
    expect(constructions).toBe(0);
  });

  it("accepts a cryptographically parseable RSA private-key envelope", () => {
    const observed: GitHubAppOctokitOptions[] = [];
    const rsaPrivateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
      type: "pkcs1",
      format: "pem",
    }).toString();

    createGitHubAppOctokit({
      ...credentials,
      private_key: rsaPrivateKey,
    }, (options) => {
      observed.push(options);
      return { request: async () => ({ data: {}, headers: {} }) } as unknown as OctokitRequestClient;
    });

    expect(observed).toHaveLength(1);
  });

  it.each([
    { ...credentials, app_id: "" },
    { ...credentials, app_id: "12a" },
    { ...credentials, installation_id: " 67890" },
    { ...credentials, private_key: "not a private key" },
    {
      ...credentials,
      private_key: "-----BEGIN PRIVATE KEY-----\ndGVzdA==\n-----END PRIVATE KEY-----",
    },
  ])("rejects invalid credentials before constructing a client", (invalid) => {
    let constructions = 0;

    expect(() => createGitHubAppOctokit(invalid, () => {
      constructions += 1;
      return { request: async () => ({ data: {}, headers: {} }) } as unknown as OctokitRequestClient;
    })).toThrowError("github_invalid_request");
    expect(constructions).toBe(0);
  });
});
