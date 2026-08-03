import { spawn } from "node:child_process";

import { loadGitHubProviderConfiguration } from "../examples/github-capability-provider/src/configuration.js";
import { provisionGitHubProvider } from "../examples/github-capability-provider/src/provision.js";

import { prepareLocalBundleEnvironment } from "./local-feishu-common.js";

const DECLARED_ENVIRONMENT = /^\$\{([A-Z_][A-Z0-9_]*)\}$/u;
const PROVIDER_OWNED_ENVIRONMENT = /^(?:GITHUB|[A-Z][A-Z0-9_]*_GITHUB)_[A-Z0-9_]+$/u;
const PROCESS_ENVIRONMENT_ALLOWLIST = Object.freeze([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SystemRoot",
  "COMSPEC",
  "PATHEXT",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "NODE_USE_ENV_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const);
const PROVIDER_CONFIGURATION_ENVIRONMENT = Object.freeze([
  "WORK_FABRIC_GITHUB_PROVIDER_CONFIG",
  "WORK_FABRIC_GITHUB_PROVIDER_CONFIG_APPLICATION",
] as const);
const RESERVED_ENVIRONMENT = new Set<string>([
  ...PROCESS_ENVIRONMENT_ALLOWLIST,
  ...PROVIDER_CONFIGURATION_ENVIRONMENT,
].map((name) => name.toUpperCase()));

function referencedEnvironment(value: string, path: string): string {
  const name = DECLARED_ENVIRONMENT.exec(value)?.[1];
  if (name === undefined) {
    throw new Error(`${path} must reference a GitHub Provider-owned environment variable`);
  }
  return providerOwnedEnvironment(name, path);
}

function providerOwnedEnvironment(name: string, path: string): string {
  if (
    !PROVIDER_OWNED_ENVIRONMENT.test(name)
    || RESERVED_ENVIRONMENT.has(name.toUpperCase())
  ) {
    throw new Error(`${path} must reference a GitHub Provider-owned environment variable`);
  }
  return name;
}

async function requiredGitHubProviderEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<readonly string[]> {
  const loaded = await loadGitHubProviderConfiguration({ environment });
  const names = [
    providerOwnedEnvironment(
      loaded.provider.authentication.app_id_environment,
      "provider.authentication.app_id_environment",
    ),
    providerOwnedEnvironment(
      loaded.provider.authentication.installation_id_environment,
      "provider.authentication.installation_id_environment",
    ),
    providerOwnedEnvironment(
      loaded.provider.authentication.private_key_environment,
      "provider.authentication.private_key_environment",
    ),
    referencedEnvironment(
      loaded.provider.cursor_signing_key,
      "provider.cursor_signing_key",
    ),
    referencedEnvironment(
      loaded.service.work_fabric.access_token,
      "service.work_fabric.access_token",
    ),
  ];
  if (new Set(names).size !== names.length) {
    throw new Error("GitHub Provider secret environment variables must be distinct");
  }
  return Object.freeze(names);
}

function requireEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): void {
  const missing = [...new Set(names)].filter((name) =>
    environment[name] === undefined || environment[name]!.length === 0
  );
  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  }
}

export async function prepareLocalGitHubProviderEnvironment(
  input: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Readonly<Record<string, string>>> {
  const environment = await prepareLocalBundleEnvironment(input, {
    required_environment: [],
    resolve_feishu_deployment_metadata: false,
  });
  const providerEnvironment = await requiredGitHubProviderEnvironment(environment);
  requireEnvironment(environment, [
    ...providerEnvironment,
    "WORK_FABRIC_ADMIN_TOKEN",
  ]);
  return environment;
}

/**
 * Builds the complete environment boundary for the standalone Provider.
 * Environment-file indirection and every non-Provider secret are intentionally
 * excluded after the administrative provisioning step.
 */
export async function createGitHubProviderChildEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<Readonly<Record<string, string>>> {
  const dynamicNames = await requiredGitHubProviderEnvironment(environment);
  requireEnvironment(environment, dynamicNames);
  const child: Record<string, string> = {};
  const processEnvironment = new Set<string>(
    PROCESS_ENVIRONMENT_ALLOWLIST.map((name) => name.toUpperCase()),
  );
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined && processEnvironment.has(name.toUpperCase())) {
      child[name] = value;
    }
  }
  for (const name of [...PROVIDER_CONFIGURATION_ENVIRONMENT, ...dynamicNames]) {
    const value = environment[name];
    if (value !== undefined) child[name] = value;
  }
  return Object.freeze(child);
}

export interface LocalGitHubProviderPorts {
  readonly prepare: (
    input: Readonly<Record<string, string | undefined>>,
  ) => Promise<Readonly<Record<string, string>>>;
  readonly provision: (
    environment: Readonly<Record<string, string>>,
  ) => Promise<unknown>;
  readonly start: (
    environment: Readonly<Record<string, string>>,
  ) => Promise<void>;
}

async function startGitHubProviderProcess(
  environment: Readonly<Record<string, string>>,
): Promise<void> {
  const child = spawn("npm", ["run", "github-provider:start"], {
    cwd: process.cwd(),
    env: environment,
    stdio: "inherit",
  });
  const code = await new Promise<number | null>((resolve) => {
    child.once("exit", resolve);
  });
  if (code !== 0) throw new Error("GitHub Provider process exited");
}

export async function runLocalGitHubProvider(
  input: Readonly<Record<string, string | undefined>>,
  ports: LocalGitHubProviderPorts,
): Promise<void> {
  const environment = await ports.prepare(input);
  await ports.provision(environment);
  const providerEnvironment = await createGitHubProviderChildEnvironment(environment);
  await ports.start(providerEnvironment);
}

export async function startLocalGitHubProvider(
  input: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  await runLocalGitHubProvider(input, {
    prepare: prepareLocalGitHubProviderEnvironment,
    provision: provisionGitHubProvider,
    start: startGitHubProviderProcess,
  });
}

if (
  process.argv[1] !== undefined
  && import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  void startLocalGitHubProvider().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Local GitHub Provider failed",
    );
    process.exitCode = 1;
  });
}
