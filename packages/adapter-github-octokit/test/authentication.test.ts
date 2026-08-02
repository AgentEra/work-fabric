import { describe, expect, it } from "vitest";

import {
  createGitHubAppOctokit,
  type GitHubAppOctokitOptions,
  type GitHubAppCredentials,
  type OctokitRequestClient,
} from "../src/index.js";

const credentials: GitHubAppCredentials = {
  app_id: "12345",
  installation_id: "67890",
  private_key: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
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
    { ...credentials, app_id: "" },
    { ...credentials, app_id: "12a" },
    { ...credentials, installation_id: " 67890" },
    { ...credentials, private_key: "not a private key" },
  ])("rejects invalid credentials before constructing a client", (invalid) => {
    let constructions = 0;

    expect(() => createGitHubAppOctokit(invalid, () => {
      constructions += 1;
      return { request: async () => ({ data: {}, headers: {} }) } as unknown as OctokitRequestClient;
    })).toThrowError("github_invalid_request");
    expect(constructions).toBe(0);
  });
});
