import { readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const GITHUB_PROVIDER_PROCESS =
  "examples/github-capability-provider/src/main.ts";

export function githubProviderProcessPresent(
  commands: readonly string[],
): boolean {
  return commands.some((command) =>
    command.split(/\s+/u).includes(GITHUB_PROVIDER_PROCESS)
  );
}

async function processCommands(): Promise<readonly string[]> {
  const entries = await readdir("/proc");
  const commands: string[] = [];
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const command = await readFile(`/proc/${entry}/cmdline`);
      commands.push(command.toString("utf8").replaceAll("\0", " "));
    } catch {
      // A process may exit between listing /proc and reading cmdline.
    }
  }
  return commands;
}

async function main(): Promise<void> {
  if (!githubProviderProcessPresent(await processCommands())) process.exitCode = 1;
}

if (
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main().catch(() => {
    process.exitCode = 1;
  });
}
