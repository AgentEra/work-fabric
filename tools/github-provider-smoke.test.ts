import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  githubReadCapabilityDeclarations,
  type GitHubPullRequestRecord,
  type GitHubRepositoryRecord,
} from "@work-fabric/provider-github";

const APPROVED_CAPABILITIES = [
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
] as const;

describe("GitHub Provider operator contract", () => {
  it("documents the complete read-only surface and deployment boundary", async () => {
    const guide = await readFile(
      new URL("../docs/guides/github-capability-provider.md", import.meta.url),
      "utf8",
    ).catch(() => "");

    expect(guide).toContain("GitHub App");
    expect(guide).toContain("Pull requests: Read");
    expect(guide).toContain("read-only");
    expect(guide).toContain(
      "office host remains the sole Feishu long-connection owner",
    );
    for (const environmentName of [
      "GITHUB_APP_ID",
      "GITHUB_APP_INSTALLATION_ID",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_PROVIDER_ACCESS_TOKEN",
      "WORK_FABRIC_GITHUB_CURSOR_SECRET",
    ]) {
      expect(guide).toContain(environmentName);
    }
    for (const capability of APPROVED_CAPABILITIES) {
      expect(guide).toContain(capability);
    }
  });

  it("keeps the opt-in smoke outside normal verification", async () => {
    const packageJson = JSON.parse(await readFile(
      new URL("../package.json", import.meta.url),
      "utf8",
    )) as { readonly scripts: Readonly<Record<string, string>> };

    expect(packageJson.scripts["github-provider:smoke"]).toBe(
      "tsx tools/github-provider-smoke.ts",
    );
    expect(packageJson.scripts.test).not.toContain("github-provider:smoke");
    expect(packageJson.scripts.verify).not.toContain("github-provider:smoke");
  });
});

const evidence = {
  provider: "github",
  fetched_at: "2026-08-03T00:00:00.000Z",
  installation_id_hash: `sha256:${"a".repeat(64)}`,
  api_version: "github-v3",
  query_scope: ["github://test"],
  complete: true,
} as const;

const repository: GitHubRepositoryRecord = {
  repository: { owner: "AgentEra", name: "work-fabric" },
  url: "https://github.com/AgentEra/work-fabric",
  description: "Provider test fixture",
  visibility: "private",
  archived: false,
  default_branch: "main",
  topics: [],
  pushed_at: "2026-08-02T00:00:00.000Z",
  updated_at: "2026-08-03T00:00:00.000Z",
};

const pullRequest: GitHubPullRequestRecord = {
  repository: repository.repository,
  number: 42,
  title: "Read-only GitHub Provider",
  url: "https://github.com/AgentEra/work-fabric/pull/42",
  author: "octocat",
  draft: false,
  base_branch: "main",
  head_branch: "github-provider",
  assignees: [],
  requested_reviewers: [],
  labels: [],
  mergeable: true,
  created_at: "2026-08-02T00:00:00.000Z",
  updated_at: "2026-08-03T00:00:00.000Z",
};

type CapabilityId = (typeof APPROVED_CAPABILITIES)[number];
type SmokeModule = typeof import("./github-provider-smoke.js");

async function smokeModule(): Promise<SmokeModule> {
  const loaded = await import("./github-provider-smoke.js").catch(() => undefined);
  expect(loaded).toBeDefined();
  return loaded!;
}

function fakeQuery(overrides: {
  readonly identity_url?: string;
  readonly repository_url?: string;
  readonly pull_request_url?: string;
} = {}) {
  const calls: Array<{ readonly capability_id: string; readonly input: unknown }> = [];
  return {
    calls,
    query: {
      async execute(capabilityId: CapabilityId, input: unknown) {
        calls.push({ capability_id: capabilityId, input: structuredClone(input) });
        if (capabilityId === "github.identity.get") {
          return {
            outcome: "succeeded" as const,
            data: {
              state: "complete",
              item: {
                app_id: "123",
                slug: "work-fabric-provider",
                name: "Work Fabric Provider",
                url: overrides.identity_url
                  ?? "https://github.com/apps/work-fabric-provider",
                owner: "AgentEra",
              },
              evidence,
            },
            artifacts: [],
          };
        }
        if (capabilityId === "github.repository.list") {
          return {
            outcome: "succeeded" as const,
            data: {
              state: "complete",
              items: [{
                ...repository,
                url: overrides.repository_url ?? repository.url,
              }],
              evidence,
            },
            artifacts: [],
          };
        }
        if (capabilityId === "github.pull_request.list") {
          return {
            outcome: "succeeded" as const,
            data: {
              state: "complete",
              items: [{
                ...pullRequest,
                url: overrides.pull_request_url ?? pullRequest.url,
              }],
              evidence,
            },
            artifacts: [],
          };
        }
        throw new Error(`unexpected capability: ${capabilityId}`);
      },
    },
  };
}

const enabledEnvironment = {
  WORK_FABRIC_GITHUB_LIVE_SMOKE: "true",
  WORK_FABRIC_GITHUB_SMOKE_ALLOWED_OWNER: "AgentEra",
} as const;

describe("GitHub Provider live smoke", () => {
  it("refuses before loading credentials or creating a network client without opt-in", async () => {
    const { runGitHubProviderSmoke } = await smokeModule();
    let loads = 0;

    await expect(runGitHubProviderSmoke({}, {
      declarations: githubReadCapabilityDeclarations,
      load: async () => {
        loads += 1;
        throw new Error("must not load");
      },
      write: () => undefined,
    })).rejects.toThrow("WORK_FABRIC_GITHUB_LIVE_SMOKE=true");
    expect(loads).toBe(0);
  });

  it("requires an explicit allowed owner before loading credentials", async () => {
    const { runGitHubProviderSmoke } = await smokeModule();
    let loads = 0;

    await expect(runGitHubProviderSmoke({
      WORK_FABRIC_GITHUB_LIVE_SMOKE: "true",
    }, {
      declarations: githubReadCapabilityDeclarations,
      load: async () => {
        loads += 1;
        throw new Error("must not load");
      },
      write: () => undefined,
    })).rejects.toThrow("WORK_FABRIC_GITHUB_SMOKE_ALLOWED_OWNER is required");
    expect(loads).toBe(0);
  });

  it("queries only identity, repositories, and owner-scoped open pull requests", async () => {
    const { runGitHubProviderSmoke } = await smokeModule();
    const fake = fakeQuery();
    const output: string[] = [];

    await runGitHubProviderSmoke(enabledEnvironment, {
      declarations: githubReadCapabilityDeclarations,
      load: async () => ({
        query: fake.query,
        tenant_id: "tenant-test",
        installation_id_hash: evidence.installation_id_hash,
        allowed_owners: ["AgentEra"],
      }),
      write: (value) => output.push(value),
    });

    expect(fake.calls).toEqual([
      { capability_id: "github.identity.get", input: {} },
      { capability_id: "github.repository.list", input: { page_size: 100 } },
      {
        capability_id: "github.pull_request.list",
        input: {
          target: { owner: "AgentEra" },
          state: "open",
          page_size: 100,
        },
      },
    ]);
    expect(output).toEqual([`${JSON.stringify({
      counts: { identity: 1, repositories: 1, open_pull_requests: 1 },
      urls: [
        "https://github.com/apps/work-fabric-provider",
        "https://github.com/AgentEra/work-fabric",
        "https://github.com/AgentEra/work-fabric/pull/42",
      ],
    })}\n`]);
    expect(output.join("")).not.toContain("Read-only GitHub Provider");
  });

  it("rejects a write declaration before loading credentials", async () => {
    const { runGitHubProviderSmoke } = await smokeModule();
    let loads = 0;
    const first = githubReadCapabilityDeclarations()[0]!;

    await expect(runGitHubProviderSmoke(enabledEnvironment, {
      declarations: () => [
        ...githubReadCapabilityDeclarations(),
        { ...first, declaration_id: "github.issue.create" },
      ],
      load: async () => {
        loads += 1;
        throw new Error("must not load");
      },
      write: () => undefined,
    })).rejects.toThrow("write-capable");
    expect(loads).toBe(0);
  });

  it("rejects an explicit owner outside the configured Provider policy", async () => {
    const { runGitHubProviderSmoke } = await smokeModule();
    const fake = fakeQuery();

    await expect(runGitHubProviderSmoke(enabledEnvironment, {
      declarations: githubReadCapabilityDeclarations,
      load: async () => ({
        query: fake.query,
        tenant_id: "tenant-test",
        installation_id_hash: evidence.installation_id_hash,
        allowed_owners: ["DifferentOwner"],
      }),
      write: () => undefined,
    })).rejects.toThrow("outside the Provider policy");
    expect(fake.calls).toEqual([]);
  });

  it("rejects secret-shaped output instead of printing it", async () => {
    const { runGitHubProviderSmoke } = await smokeModule();
    const fake = fakeQuery({
      pull_request_url: "https://github.com/AgentEra/work-fabric/pull/42?token=ghp_abcdefghijklmnopqrstuvwxyz123456",
    });
    const output: string[] = [];

    await expect(runGitHubProviderSmoke(enabledEnvironment, {
      declarations: githubReadCapabilityDeclarations,
      load: async () => ({
        query: fake.query,
        tenant_id: "tenant-test",
        installation_id_hash: evidence.installation_id_hash,
        allowed_owners: ["AgentEra"],
      }),
      write: (value) => output.push(value),
    })).rejects.toThrow("secret-shaped");
    expect(output).toEqual([]);
  });
});
