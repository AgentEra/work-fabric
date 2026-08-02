import { describe, expect, it } from "vitest";

import {
  GitHubPolicyEvaluator,
  parseGitHubCapabilityInput,
} from "../src/index.js";

const policy = new GitHubPolicyEvaluator({
  allowed_owners: ["AgentEra"],
  allowed_repositories: [{ owner: "AgentEra", name: "work-fabric" }],
  maximum_page_size: 50,
  maximum_aggregate_repositories: 2,
});

describe("parseGitHubCapabilityInput", () => {
  it("resolves list defaults and produces a query scope", () => {
    const parsed = parseGitHubCapabilityInput(
      "github.pull_request.list",
      { target: { owner: "AgentEra" } },
      policy,
    );

    expect(parsed).toMatchObject({
      capability_id: "github.pull_request.list",
      page: 1,
      page_size: 30,
      input: { target: { owner: "AgentEra" }, state: "open" },
      scope_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
  });

  it("rejects unknown fields and values outside the policy before execution", () => {
    expect(() => parseGitHubCapabilityInput(
      "github.pull_request.list",
      { target: { owner: "AgentEra" }, unexpected: true },
      policy,
    )).toThrowError("github_invalid_request");
    expect(() => parseGitHubCapabilityInput(
      "github.repository.get",
      { repository: { owner: "other", name: "secret" } },
      policy,
    )).toThrowError("github_forbidden");
    expect(() => parseGitHubCapabilityInput(
      "github.repository.list",
      { page_size: 51 },
      policy,
    )).toThrowError("github_forbidden");
  });

  it("rejects present fields whose values are absent from the declared JSON schema", () => {
    expect(() => parseGitHubCapabilityInput(
      "github.pull_request.list",
      { target: { owner: "AgentEra" }, state: undefined },
      policy,
    )).toThrowError("github_invalid_request");
    expect(() => parseGitHubCapabilityInput(
      "github.pull_request.comments.list",
      {
        repository: { owner: "AgentEra", name: "work-fabric" },
        pull_request_number: 1,
        kind: undefined,
      },
      policy,
    )).toThrowError("github_invalid_request");
  });

  it("canonicalizes repository references and binds scope to filters rather than cursors", () => {
    const first = parseGitHubCapabilityInput(
      "github.commit.list",
      {
        repository: { owner: " AgentEra ", name: " work-fabric " },
        ref: "main",
        cursor: "opaque-continuation",
      },
      policy,
    );
    const second = parseGitHubCapabilityInput(
      "github.commit.list",
      {
        repository: { owner: "AgentEra", name: "work-fabric" },
        ref: "main",
      },
      policy,
    );

    expect(first.page).toBe(1);
    expect(first.input).toMatchObject({
      repository: { owner: "AgentEra", name: "work-fabric" },
      cursor: "opaque-continuation",
    });
    expect(first.scope_hash).toBe(second.scope_hash);
  });
});
