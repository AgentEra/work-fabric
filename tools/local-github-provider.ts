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
] as const);

export async function prepareLocalGitHubProviderEnvironment(
  input: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Readonly<Record<string, string>>> {
  const environment = await prepareLocalBundleEnvironment(input, []);
  const missing = LOCAL_GITHUB_REQUIRED_ENVIRONMENT.filter(
    (name) => environment[name] === undefined || environment[name]!.length === 0,
  );
  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  }
  await loadGitHubProviderConfiguration({ environment });
  return environment;
}

export async function startLocalGitHubProvider(
  input: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const environment = await prepareLocalGitHubProviderEnvironment(input);
  await provisionGitHubProvider(environment);
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
