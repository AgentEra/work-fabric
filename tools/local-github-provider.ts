import { spawn } from "node:child_process";

import { loadGitHubProviderConfiguration } from "../examples/github-capability-provider/src/configuration.js";
import { provisionGitHubProvider } from "../examples/github-capability-provider/src/provision.js";

import { prepareLocalBundleEnvironment } from "./local-feishu-common.js";

export const LOCAL_GITHUB_REQUIRED_ENVIRONMENT = Object.freeze([
  "GITHUB_APP_ID",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_PROVIDER_ACCESS_TOKEN",
  "WORK_FABRIC_GITHUB_CURSOR_SECRET",
  "WORK_FABRIC_ADMIN_TOKEN",
] as const);

export async function prepareLocalGitHubProviderEnvironment(
  input: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Readonly<Record<string, string>>> {
  const environment = await prepareLocalBundleEnvironment(input, {
    required_environment: [],
    resolve_feishu_deployment_metadata: false,
  });
  const missing = LOCAL_GITHUB_REQUIRED_ENVIRONMENT.filter(
    (name) => environment[name] === undefined || environment[name]!.length === 0,
  );
  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  }
  await loadGitHubProviderConfiguration({ environment });
  return environment;
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
  const {
    WORK_FABRIC_ADMIN_TOKEN: _administrativeToken,
    ...providerEnvironment
  } = environment;
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
