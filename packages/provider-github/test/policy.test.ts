import { describe, expect, it } from "vitest";

import {
  GitHubPolicyEvaluator,
  type GitHubProviderPolicy,
} from "../src/index.js";

const policy: GitHubProviderPolicy = {
  allowed_owners: ["AgentEra"],
  allowed_repositories: [{ owner: "AgentEra", name: "work-fabric" }],
  maximum_page_size: 5,
  maximum_aggregate_repositories: 2,
};

describe("GitHubPolicyEvaluator", () => {
  it("rejects a repository outside the configured owner ceiling", () => {
    const evaluator = new GitHubPolicyEvaluator({
      allowed_owners: ["AgentEra"],
      allowed_repositories: [],
      maximum_page_size: 5,
      maximum_aggregate_repositories: 100,
    });

    expect(() => evaluator.authorizeRepository({ owner: "other", name: "secret" }))
      .toThrowError("github_forbidden");
  });

  it("matches repository ceilings case-insensitively and returns trimmed references", () => {
    const evaluator = new GitHubPolicyEvaluator(policy);

    expect(evaluator.authorizeRepository({
      owner: "  agentera ", name: " WORK-FABRIC ",
    })).toEqual({ owner: "agentera", name: "WORK-FABRIC" });
    expect(() => evaluator.authorizeRepository({
      owner: "AgentEra", name: "other",
    })).toThrowError("github_forbidden");
  });

  it("treats an empty repository allowlist as all repositories of allowed owners only", () => {
    const evaluator = new GitHubPolicyEvaluator({
      ...policy,
      allowed_repositories: [],
    });

    expect(evaluator.authorizeRepository({ owner: "AgentEra", name: "other" }))
      .toEqual({ owner: "AgentEra", name: "other" });
    expect(() => evaluator.authorizeOwner("other")).toThrowError("github_forbidden");
  });

  it("enforces page and aggregate repository ceilings", () => {
    const evaluator = new GitHubPolicyEvaluator(policy);

    expect(() => evaluator.authorizePageSize(6)).toThrowError("github_invalid_request");
    expect(() => evaluator.authorizeRepositories([
      { owner: "AgentEra", name: "work-fabric" },
      { owner: "AgentEra", name: "work-fabric" },
      { owner: "AgentEra", name: "work-fabric" },
    ])).toThrowError("github_forbidden");
  });

  it("rejects a configured page ceiling above the MVP result bound", () => {
    expect(() => new GitHubPolicyEvaluator({
      ...policy,
      maximum_page_size: 6,
    })).toThrowError("github_invalid_request");
  });
});
