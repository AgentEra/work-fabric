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
  api_version: "2022-11-28",
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
  head_sha: "abc1234",
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
  readonly repository_items?: readonly GitHubRepositoryRecord[];
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
                installation_repository_count: 1,
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
              items: overrides.repository_items ?? [{
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

function fakePreflight(overrides: {
  readonly allowed_owners?: readonly string[];
  readonly allowed_repositories?: readonly {
    readonly owner: string;
    readonly name: string;
  }[];
} = {}) {
  return {
    tenant_id: "tenant-test",
    authentication: {
      mode: "github_app" as const,
      credential_ref: "github-primary",
      app_id_environment: "GITHUB_APP_ID",
      installation_id_environment: "GITHUB_APP_INSTALLATION_ID",
      private_key_environment: "GITHUB_APP_PRIVATE_KEY",
    },
    cursor_environment: "WORK_FABRIC_GITHUB_CURSOR_SECRET",
    required_environment_names: [],
    policy: {
      allowed_owners: overrides.allowed_owners ?? ["AgentEra"],
      allowed_repositories: overrides.allowed_repositories ?? [],
      maximum_page_size: 5,
      maximum_aggregate_repositories: 100,
    },
  };
}

describe("GitHub Provider live smoke", () => {
  it("refuses before loading credentials or creating a network client without opt-in", async () => {
    const { runGitHubProviderSmoke } = await smokeModule();
    let preflightLoads = 0;
    let runtimeLoads = 0;

    await expect(runGitHubProviderSmoke({}, {
      declarations: githubReadCapabilityDeclarations,
      preflight: async () => {
        preflightLoads += 1;
        return fakePreflight();
      },
      loadRuntime: async () => {
        runtimeLoads += 1;
        throw new Error("must not load");
      },
      write: () => undefined,
    })).rejects.toThrow("WORK_FABRIC_GITHUB_LIVE_SMOKE=true");
    expect(preflightLoads).toBe(1);
    expect(runtimeLoads).toBe(0);
  });

  it("requires an explicit allowed owner before loading credentials", async () => {
    const { runGitHubProviderSmoke } = await smokeModule();
    let runtimeLoads = 0;

    await expect(runGitHubProviderSmoke({
      WORK_FABRIC_GITHUB_LIVE_SMOKE: "true",
    }, {
      declarations: githubReadCapabilityDeclarations,
      preflight: async () => fakePreflight(),
      loadRuntime: async () => {
        runtimeLoads += 1;
        throw new Error("must not load");
      },
      write: () => undefined,
    })).rejects.toThrow("WORK_FABRIC_GITHUB_SMOKE_ALLOWED_OWNER is required");
    expect(runtimeLoads).toBe(0);
  });

  it("queries only identity, repositories, and owner-scoped open pull requests", async () => {
    const { runGitHubProviderSmoke } = await smokeModule();
    const fake = fakeQuery();
    const output: string[] = [];

    await runGitHubProviderSmoke(enabledEnvironment, {
      declarations: githubReadCapabilityDeclarations,
      preflight: async () => fakePreflight(),
      loadRuntime: async () => ({
        query: fake.query,
        tenant_id: "tenant-test",
        installation_id_hash: evidence.installation_id_hash,
      }),
      write: (value) => output.push(value),
    });

    expect(fake.calls).toEqual([
      { capability_id: "github.identity.get", input: {} },
      { capability_id: "github.repository.list", input: { page_size: 5 } },
      {
        capability_id: "github.pull_request.list",
        input: {
          target: { owner: "AgentEra" },
          state: "open",
          page_size: 5,
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
    let runtimeLoads = 0;
    const first = githubReadCapabilityDeclarations()[0]!;

    await expect(runGitHubProviderSmoke(enabledEnvironment, {
      declarations: () => [
        ...githubReadCapabilityDeclarations(),
        { ...first, declaration_id: "github.issue.create" },
      ],
      preflight: async () => fakePreflight(),
      loadRuntime: async () => {
        runtimeLoads += 1;
        throw new Error("must not load");
      },
      write: () => undefined,
    })).rejects.toThrow("write-capable");
    expect(runtimeLoads).toBe(0);
  });

  it("rejects an explicit owner outside the configured Provider policy", async () => {
    const { runGitHubProviderSmoke } = await smokeModule();
    const fake = fakeQuery();
    let runtimeLoads = 0;

    await expect(runGitHubProviderSmoke(enabledEnvironment, {
      declarations: githubReadCapabilityDeclarations,
      preflight: async () => fakePreflight({
        allowed_owners: ["DifferentOwner"],
      }),
      loadRuntime: async () => {
        runtimeLoads += 1;
        return {
          query: fake.query,
          tenant_id: "tenant-test",
          installation_id_hash: evidence.installation_id_hash,
        };
      },
      write: () => undefined,
    })).rejects.toThrow("outside the Provider policy");
    expect(runtimeLoads).toBe(0);
    expect(fake.calls).toEqual([]);
  });

  it("rejects every cross-owner repository-list attestation", async () => {
    const { runGitHubProviderSmoke } = await smokeModule();
    const fake = fakeQuery({
      repository_items: [{
        ...repository,
        repository: { owner: "DifferentOwner", name: "work-fabric" },
        url: "https://github.com/DifferentOwner/work-fabric",
      }],
    });
    const output: string[] = [];

    await expect(runGitHubProviderSmoke(enabledEnvironment, {
      declarations: githubReadCapabilityDeclarations,
      preflight: async () => fakePreflight(),
      loadRuntime: async () => ({
        query: fake.query,
        tenant_id: "tenant-test",
        installation_id_hash: evidence.installation_id_hash,
      }),
      write: (value) => output.push(value),
    })).rejects.toThrow("outside the selected owner");
    expect(output).toEqual([]);
  });

  it("rejects duplicate repository-list attestations", async () => {
    const { runGitHubProviderSmoke } = await smokeModule();
    const fake = fakeQuery({ repository_items: [repository, repository] });
    const output: string[] = [];

    await expect(runGitHubProviderSmoke(enabledEnvironment, {
      declarations: githubReadCapabilityDeclarations,
      preflight: async () => fakePreflight(),
      loadRuntime: async () => ({
        query: fake.query,
        tenant_id: "tenant-test",
        installation_id_hash: evidence.installation_id_hash,
      }),
      write: (value) => output.push(value),
    })).rejects.toThrow("duplicate repository");
    expect(output).toEqual([]);
  });

  it("rejects result URLs outside a configured repository ceiling", async () => {
    const { runGitHubProviderSmoke } = await smokeModule();
    const fake = fakeQuery();
    const output: string[] = [];

    await expect(runGitHubProviderSmoke(enabledEnvironment, {
      declarations: githubReadCapabilityDeclarations,
      preflight: async () => fakePreflight({
        allowed_repositories: [{ owner: "AgentEra", name: "approved-only" }],
      }),
      loadRuntime: async () => ({
        query: fake.query,
        tenant_id: "tenant-test",
        installation_id_hash: evidence.installation_id_hash,
      }),
      write: (value) => output.push(value),
    })).rejects.toThrow("outside the Provider repository policy");
    expect(output).toEqual([]);
  });

  it("rejects secret-shaped output instead of printing it", async () => {
    const { runGitHubProviderSmoke } = await smokeModule();
    const fake = fakeQuery({
      pull_request_url: "https://github.com/AgentEra/work-fabric/pull/42?token=ghp_abcdefghijklmnopqrstuvwxyz123456",
    });
    const output: string[] = [];

    await expect(runGitHubProviderSmoke(enabledEnvironment, {
      declarations: githubReadCapabilityDeclarations,
      preflight: async () => fakePreflight(),
      loadRuntime: async () => ({
        query: fake.query,
        tenant_id: "tenant-test",
        installation_id_hash: evidence.installation_id_hash,
      }),
      write: (value) => output.push(value),
    })).rejects.toThrow("secret-shaped");
    expect(output).toEqual([]);
  });
});
