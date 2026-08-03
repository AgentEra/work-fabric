import {
  createGitHubAppOctokit,
  OctokitGitHubReadApi,
} from "@work-fabric/adapter-github-octokit";
import {
  GITHUB_MAX_PAGE_SIZE,
  GITHUB_READ_CAPABILITY_IDS,
  GitHubPolicyEvaluator,
  GitHubQueryService,
  HmacGitHubCursorCodec,
  githubReadCapabilityDeclarations,
  type GitHubProviderPolicy,
} from "@work-fabric/provider-github";
import type {
  CitizenDeclaration,
  CitizenJsonObject,
} from "@work-fabric/network-citizen-spi";

import {
  loadGitHubProviderConfiguration,
  type GitHubProviderAuthentication,
} from "../examples/github-capability-provider/src/configuration.js";
import { EnvironmentGitHubCredentialProvider } from "../examples/github-capability-provider/src/credentials.js";
import { githubProviderEvidenceIdentity } from "../examples/github-capability-provider/src/composition.js";

type GitHubSmokeCapabilityId =
  | "github.identity.get"
  | "github.repository.list"
  | "github.pull_request.list";

export interface GitHubSmokeQueryPort {
  execute(
    capabilityId: GitHubSmokeCapabilityId,
    input: CitizenJsonObject,
    context: {
      readonly tenant_id: string;
      readonly installation_id_hash: string;
      readonly signal: AbortSignal;
    },
  ): Promise<unknown>;
}

export interface GitHubSmokeRuntime {
  readonly query: GitHubSmokeQueryPort;
  readonly tenant_id: string;
  readonly installation_id_hash: string;
}

export interface GitHubSmokePreflight {
  readonly tenant_id: string;
  readonly authentication: GitHubProviderAuthentication;
  readonly cursor_environment: string;
  readonly required_environment_names: readonly string[];
  readonly policy: GitHubProviderPolicy;
}

export interface GitHubProviderSmokeDependencies {
  readonly declarations: () => readonly CitizenDeclaration[];
  readonly preflight: (
    environment: Readonly<Record<string, string | undefined>>,
  ) => Promise<GitHubSmokePreflight>;
  readonly loadRuntime: (
    environment: Readonly<Record<string, string | undefined>>,
    preflight: GitHubSmokePreflight,
  ) => Promise<GitHubSmokeRuntime>;
  readonly write: (value: string) => void;
}

const MUTATION_WORD = /\b(?:create|update|delete|merge|close|rerun|cancel|dispatch)\b/iu;
const SECRET_SHAPE = /(?:-----BEGIN (?:RSA )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|\bBearer\s+[A-Za-z0-9._~-]{10,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|[?&](?:access_token|token|private_key|key|secret)=)/iu;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/u;
const ENVIRONMENT_REFERENCE = /^\$\{([A-Z_][A-Z0-9_]*)\}$/u;

function record(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(message);
  return value;
}

function assertReadOnlyDeclarations(declarations: readonly CitizenDeclaration[]): void {
  const approved = new Set<string>(GITHUB_READ_CAPABILITY_IDS);
  const identifiers = declarations.map((item) => item.declaration_id);
  const unique = new Set(identifiers);
  if (
    declarations.length !== GITHUB_READ_CAPABILITY_IDS.length ||
    unique.size !== declarations.length ||
    identifiers.some((identifier) => !approved.has(identifier)) ||
    GITHUB_READ_CAPABILITY_IDS.some((identifier) => !unique.has(identifier)) ||
    declarations.some((item) =>
      item.declaration_kind !== "capability" ||
      item.risk !== "low" ||
      item.confirmation !== "none" ||
      record(item.constraints, "GitHub smoke refused an invalid declaration")
        .operation_kind !== "query" ||
      MUTATION_WORD.test(`${item.declaration_id} ${item.name} ${item.description}`)
    )
  ) {
    throw new Error("GitHub smoke refused a write-capable or unapproved declaration");
  }
}

function explicitOwner(environment: Readonly<Record<string, string | undefined>>): string {
  const owner = environment.WORK_FABRIC_GITHUB_SMOKE_ALLOWED_OWNER;
  if (owner === undefined || owner.trim() !== owner || !OWNER.test(owner)) {
    throw new Error("WORK_FABRIC_GITHUB_SMOKE_ALLOWED_OWNER is required");
  }
  return owner;
}

function assertNoSecretShape(value: string): void {
  if (SECRET_SHAPE.test(value)) {
    throw new Error("GitHub smoke refused secret-shaped output");
  }
}

function parsedUrl(value: unknown): URL {
  const raw = text(value, "GitHub smoke received an invalid URL");
  assertNoSecretShape(raw);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("GitHub smoke received an invalid URL");
  }
  if (
    url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" ||
    url.port !== "" || url.username !== "" || url.password !== "" ||
    url.search !== "" || url.hash !== ""
  ) {
    throw new Error("GitHub smoke refused a non-public URL");
  }
  return url;
}

function segments(url: URL): readonly string[] {
  try {
    const values = url.pathname.split("/").filter((item) => item.length > 0)
      .map((item) => decodeURIComponent(item));
    if (values.some((item) => item.length === 0 || item.includes("/") || item.includes("\\"))) {
      throw new Error("invalid");
    }
    return values;
  } catch {
    throw new Error("GitHub smoke received an invalid URL");
  }
}

function authorizedIdentityUrl(value: unknown): string {
  const url = parsedUrl(value);
  const path = segments(url);
  if (path.length !== 2 || path[0] !== "apps") {
    throw new Error("GitHub smoke refused an unauthorized identity URL");
  }
  return url.href;
}

function equal(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function allowedRepository(
  owner: string,
  name: string,
  ceiling: GitHubProviderPolicy["allowed_repositories"],
): boolean {
  return ceiling.length === 0 || ceiling.some((repository) =>
    equal(repository.owner, owner) && equal(repository.name, name)
  );
}

function repositoryRecord(
  value: unknown,
  policy: GitHubProviderPolicy,
): {
  readonly owner: string;
  readonly name: string;
  readonly url: string;
} {
  const item = record(value, "GitHub smoke received an invalid repository result");
  const repository = record(
    item.repository,
    "GitHub smoke received an invalid repository result",
  );
  const resultOwner = text(repository.owner, "GitHub smoke received an invalid repository owner");
  const name = text(repository.name, "GitHub smoke received an invalid repository name");
  if (!policy.allowed_owners.some((owner) => equal(resultOwner, owner))) {
    throw new Error("GitHub smoke repository result is outside the Provider owner policy");
  }
  if (!allowedRepository(resultOwner, name, policy.allowed_repositories)) {
    throw new Error("GitHub smoke result is outside the Provider repository policy");
  }
  const url = parsedUrl(item.url);
  const path = segments(url);
  if (
    path.length !== 2 || !equal(path[0]!, resultOwner) || !equal(path[1]!, name)
  ) throw new Error("GitHub smoke refused an unauthorized repository URL");
  return { owner: resultOwner, name, url: url.href };
}

function pullRequestUrl(
  value: unknown,
  owner: string,
  ceiling: GitHubProviderPolicy["allowed_repositories"],
): string {
  const item = record(value, "GitHub smoke received an invalid pull request result");
  const repository = record(
    item.repository,
    "GitHub smoke received an invalid pull request result",
  );
  const resultOwner = text(repository.owner, "GitHub smoke received an invalid pull request owner");
  const name = text(repository.name, "GitHub smoke received an invalid pull request repository");
  if (!equal(resultOwner, owner)) {
    throw new Error("GitHub smoke refused a cross-owner pull request");
  }
  if (!allowedRepository(resultOwner, name, ceiling)) {
    throw new Error("GitHub smoke result is outside the Provider repository policy");
  }
  if (!Number.isSafeInteger(item.number) || (item.number as number) < 1) {
    throw new Error("GitHub smoke received an invalid pull request number");
  }
  const url = parsedUrl(item.url);
  const path = segments(url);
  if (
    path.length !== 4 || !equal(path[0]!, owner) || !equal(path[1]!, name) ||
    path[2] !== "pull" || path[3] !== String(item.number)
  ) throw new Error("GitHub smoke refused an unauthorized pull request URL");
  return url.href;
}

function succeededData(result: unknown, capabilityId: GitHubSmokeCapabilityId): Record<string, unknown> {
  const response = record(result, `GitHub smoke ${capabilityId} returned an invalid result`);
  if (response.outcome !== "succeeded") {
    const code = typeof response.code === "string" && /^github_[a-z_]+$/u.test(response.code)
      ? response.code
      : "github_query_failed";
    throw new Error(`GitHub smoke ${capabilityId} failed: ${code}`);
  }
  return record(response.data, `GitHub smoke ${capabilityId} returned invalid data`);
}

function pageItems(data: Record<string, unknown>, capabilityId: GitHubSmokeCapabilityId): readonly unknown[] {
  if (!["empty", "complete", "truncated"].includes(String(data.state))) {
    throw new Error(`GitHub smoke ${capabilityId} returned an invalid page state`);
  }
  if (!Array.isArray(data.items) || data.items.length > GITHUB_MAX_PAGE_SIZE) {
    throw new Error(`GitHub smoke ${capabilityId} returned an invalid page`);
  }
  return data.items;
}

function environmentName(reference: string, path: string): string {
  const match = ENVIRONMENT_REFERENCE.exec(reference);
  if (match?.[1] === undefined) {
    throw new Error(`${path} must remain an environment reference`);
  }
  return match[1];
}

function requireEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): void {
  const missing = [...new Set(names)].filter((name) => {
    const value = environment[name];
    return value === undefined || value.length === 0;
  });
  if (missing.length > 0) {
    throw new Error(`Missing GitHub Provider environment: ${missing.join(", ")}`);
  }
}

async function loadLiveRuntime(
  environment: Readonly<Record<string, string | undefined>>,
  preflight: GitHubSmokePreflight,
): Promise<GitHubSmokeRuntime> {
  requireEnvironment(environment, preflight.required_environment_names);
  const credentials = await new EnvironmentGitHubCredentialProvider({
    ...preflight.authentication,
    environment,
  }).load();
  const api = new OctokitGitHubReadApi(createGitHubAppOctokit(credentials));
  const cursorKey = Buffer.from(environment[preflight.cursor_environment]!, "utf8");
  const evidenceIdentity = githubProviderEvidenceIdentity(
    credentials.installation_id,
    cursorKey,
  );
  const query = new GitHubQueryService({
    api,
    policy: new GitHubPolicyEvaluator(preflight.policy),
    cursor: new HmacGitHubCursorCodec({
      key: cursorKey,
    }),
    api_version: evidenceIdentity.api_version,
  });
  return {
    query,
    tenant_id: preflight.tenant_id,
    installation_id_hash: evidenceIdentity.installation_id_hash,
  };
}

async function loadPreflight(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<GitHubSmokePreflight> {
  const loaded = await loadGitHubProviderConfiguration({ environment });
  const authentication = loaded.provider.authentication;
  const accessTokenEnvironment = environmentName(
    loaded.service.work_fabric.access_token,
    "service.work_fabric.access_token",
  );
  const cursorEnvironment = environmentName(
    loaded.provider.cursor_signing_key,
    "provider.cursor_signing_key",
  );
  return {
    tenant_id: loaded.service.work_fabric.tenant_id,
    authentication,
    cursor_environment: cursorEnvironment,
    required_environment_names: [
      authentication.app_id_environment,
      authentication.installation_id_environment,
      authentication.private_key_environment,
      accessTokenEnvironment,
      cursorEnvironment,
    ],
    policy: loaded.provider.policy,
  };
}

const liveDependencies: GitHubProviderSmokeDependencies = {
  declarations: githubReadCapabilityDeclarations,
  preflight: loadPreflight,
  loadRuntime: loadLiveRuntime,
  write: (value) => process.stdout.write(value),
};

/** Runs three bounded Provider queries and emits counts plus authorized URLs only. */
export async function runGitHubProviderSmoke(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: GitHubProviderSmokeDependencies = liveDependencies,
): Promise<void> {
  const preflight = await dependencies.preflight(environment);
  if (environment.WORK_FABRIC_GITHUB_LIVE_SMOKE !== "true") {
    throw new Error("GitHub smoke requires WORK_FABRIC_GITHUB_LIVE_SMOKE=true");
  }
  const owner = explicitOwner(environment);
  assertReadOnlyDeclarations(dependencies.declarations());
  if (!preflight.policy.allowed_owners.some((allowed) => equal(allowed, owner))) {
    throw new Error("GitHub smoke owner is outside the Provider policy");
  }
  const runtime = await dependencies.loadRuntime(environment, preflight);
  const context = {
    tenant_id: runtime.tenant_id,
    installation_id_hash: runtime.installation_id_hash,
    signal: new AbortController().signal,
  };
  const identityData = succeededData(
    await runtime.query.execute("github.identity.get", {}, context),
    "github.identity.get",
  );
  if (identityData.state !== "complete") {
    throw new Error("GitHub smoke identity query was incomplete");
  }
  const identityUrl = authorizedIdentityUrl(
    record(identityData.item, "GitHub smoke identity result is invalid").url,
  );
  const repositoryData = succeededData(
    await runtime.query.execute("github.repository.list", { page_size: 5 }, context),
    "github.repository.list",
  );
  const repositories = pageItems(repositoryData, "github.repository.list")
    .map((item) => repositoryRecord(
      item,
      preflight.policy,
    ));
  const repositoryIdentities = new Set(
    repositories.map((item) => `${item.owner.toLowerCase()}/${item.name.toLowerCase()}`),
  );
  if (repositoryIdentities.size !== repositories.length) {
    throw new Error("GitHub smoke received a duplicate repository result");
  }
  const pullRequestData = succeededData(
    await runtime.query.execute("github.pull_request.list", {
      target: { owner },
      state: "open",
      page_size: 5,
    }, context),
    "github.pull_request.list",
  );
  const pullRequestUrls = pageItems(pullRequestData, "github.pull_request.list")
    .map((item) =>
      pullRequestUrl(item, owner, preflight.policy.allowed_repositories)
    );
  const output = JSON.stringify({
    counts: {
      identity: 1,
      repositories: repositories.length,
      open_pull_requests: pullRequestUrls.length,
    },
    urls: [identityUrl, ...repositories.map((item) => item.url), ...pullRequestUrls],
  });
  assertNoSecretShape(output);
  dependencies.write(`${output}\n`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  void runGitHubProviderSmoke().catch(() => {
    process.stderr.write("GitHub Provider live smoke failed safely\n");
    process.exitCode = 1;
  });
}
