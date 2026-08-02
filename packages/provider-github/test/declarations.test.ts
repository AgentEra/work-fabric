import { describe, expect, it } from "vitest";

import {
  GITHUB_READ_CAPABILITY_IDS,
  githubReadCapabilityDeclarations,
} from "../src/index.js";

describe("GitHub read capability declarations", () => {
  it("declares exactly the approved read-only surface", () => {
    expect(GITHUB_READ_CAPABILITY_IDS).toEqual([
      "github.identity.get",
      "github.repository.list",
      "github.repository.get",
      "github.pull_request.list",
      "github.pull_request.get",
      "github.pull_request.reviews.list",
      "github.pull_request.comments.list",
      "github.pull_request.files.list",
      "github.pull_request.commits.list",
      "github.pull_request.checks.get",
      "github.actions.workflow_runs.list",
      "github.commit.list",
    ]);
    const declarations = githubReadCapabilityDeclarations();
    expect(declarations).toHaveLength(12);
    expect(declarations.every((item) =>
      item.version === "1.0.0" &&
      item.risk === "low" &&
      item.confirmation === "none"
    )).toBe(true);
    expect(JSON.stringify(declarations)).not.toMatch(
      /create|update|delete|merge|close|rerun|cancel/i,
    );
  });
});
