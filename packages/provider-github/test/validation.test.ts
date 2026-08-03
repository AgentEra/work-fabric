import { describe, expect, it } from "vitest";

import {
  GITHUB_READ_CAPABILITY_IDS,
  GitHubPolicyEvaluator,
  parseGitHubCapabilityInput,
} from "../src/index.js";

const policy = new GitHubPolicyEvaluator({
  allowed_owners: ["AgentEra"],
  allowed_repositories: [{ owner: "AgentEra", name: "work-fabric" }],
  maximum_page_size: 5,
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
      page_size: 5,
      input: {
        target: { repositories: [{ owner: "AgentEra", name: "work-fabric" }] },
        state: "open",
      },
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
      { page_size: 6 },
      policy,
    )).toThrowError("github_invalid_request");
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

  it("narrows an owner target to its deterministically sorted repository allowlist", () => {
    const evaluator = new GitHubPolicyEvaluator({
      allowed_owners: ["AgentEra", "Other"],
      allowed_repositories: [
        { owner: "AgentEra", name: "zeta" },
        { owner: "AgentEra", name: "alpha" },
      ],
      maximum_page_size: 5,
      maximum_aggregate_repositories: 100,
    });

    expect(parseGitHubCapabilityInput(
      "github.pull_request.list",
      { target: { owner: " AgentEra " } },
      evaluator,
    ).input).toMatchObject({ target: { repositories: [
      { owner: "AgentEra", name: "alpha" },
      { owner: "AgentEra", name: "zeta" },
    ] } });
    expect(() => parseGitHubCapabilityInput(
      "github.pull_request.list",
      { target: { owner: "Other" } },
      evaluator,
    )).toThrowError("github_forbidden");
    expect(parseGitHubCapabilityInput(
      "github.pull_request.list",
      { target: { owner: "AgentEra" } },
      new GitHubPolicyEvaluator({
        allowed_owners: ["AgentEra"],
        allowed_repositories: [],
        maximum_page_size: 5,
        maximum_aggregate_repositories: 2,
      }),
    ).input).toMatchObject({ target: { owner: "AgentEra" } });
  });

  it("rejects repository target arrays outside the declared bounds before policy ceilings", () => {
    const permissiveCeiling = new GitHubPolicyEvaluator({
      allowed_owners: ["AgentEra"],
      allowed_repositories: [],
      maximum_page_size: 5,
      maximum_aggregate_repositories: 101,
    });
    const repository = { owner: "AgentEra", name: "work-fabric" };

    expect(() => parseGitHubCapabilityInput(
      "github.pull_request.list",
      { target: { repositories: [] } },
      permissiveCeiling,
    )).toThrowError("github_invalid_request");
    expect(() => parseGitHubCapabilityInput(
      "github.pull_request.list",
      { target: { repositories: Array.from({ length: 101 }, () => repository) } },
      permissiveCeiling,
    )).toThrowError("github_invalid_request");
    expect(() => parseGitHubCapabilityInput(
      "github.pull_request.list",
      { target: { repositories: Array.from({ length: 3 }, () => repository) } },
      policy,
    )).toThrowError("github_forbidden");
  });

  it("requires valid RFC3339 date-times for declared date-time filters", () => {
    const input = { repository: { owner: "AgentEra", name: "work-fabric" } };

    for (const since of [
      "2026-08-02",
      "2026-02-30T00:00:00Z",
      "2026-08-02T01:02:03+24:00",
    ]) {
      expect(() => parseGitHubCapabilityInput(
        "github.commit.list", { ...input, since }, policy,
      )).toThrowError("github_invalid_request");
    }
    expect(parseGitHubCapabilityInput(
      "github.commit.list",
      { ...input, since: "2026-08-02T01:02:03Z", until: "2026-08-02T09:02:03+08:00" },
      policy,
    ).input).toMatchObject({
      since: "2026-08-02T01:02:03Z",
      until: "2026-08-02T09:02:03+08:00",
    });
    expect(parseGitHubCapabilityInput(
      "github.commit.list",
      {
        ...input,
        since: "2026-08-02t01:02:03z",
        until: "2016-12-31T23:59:60Z",
      },
      policy,
    ).input).toMatchObject({
      since: "2026-08-02t01:02:03z",
      until: "2016-12-31T23:59:60Z",
    });
  });

  it("accepts schema-shaped minimal input for every declared capability", () => {
    const repository = { owner: "AgentEra", name: "work-fabric" };
    const inputs: Record<(typeof GITHUB_READ_CAPABILITY_IDS)[number], unknown> = {
      "github.identity.get": {},
      "github.repository.list": {},
      "github.repository.get": { repository },
      "github.pull_request.list": { target: { repository } },
      "github.pull_request.get": { repository, number: 1 },
      "github.pull_request.reviews.list": { repository, pull_request_number: 1 },
      "github.pull_request.comments.list": { repository, pull_request_number: 1 },
      "github.pull_request.files.list": { repository, pull_request_number: 1 },
      "github.pull_request.commits.list": { repository, pull_request_number: 1 },
      "github.pull_request.checks.get": { repository, number: 1 },
      "github.actions.workflow_runs.list": { repository },
      "github.commit.list": { repository },
    };

    for (const capabilityId of GITHUB_READ_CAPABILITY_IDS) {
      expect(() => parseGitHubCapabilityInput(capabilityId, inputs[capabilityId], policy))
        .not.toThrow();
    }
  });
});
