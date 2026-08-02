import { readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const REQUIRED_PROCESSES = Object.freeze([
  "packages/service-node/src/main.ts",
  "examples/feishu-capability-provider/src/main.ts",
  "examples/agently-agent-runtime/src/main.ts",
]);

export function requiredProcessesPresent(
  commands: readonly string[],
): boolean {
  const candidates = REQUIRED_PROCESSES.map((required) =>
    commands.flatMap((command, index) =>
      command.split(/\s+/u).includes(required) ? [index] : []
    )
  );
  const assign = (requiredIndex: number, used: ReadonlySet<number>): boolean => {
    if (requiredIndex === candidates.length) return true;
    return candidates[requiredIndex]!.some((commandIndex) => {
      if (used.has(commandIndex)) return false;
      return assign(requiredIndex + 1, new Set([...used, commandIndex]));
    });
  };
  return assign(0, new Set());
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

export async function officeStackHealthy(
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
  commands: () => Promise<readonly string[]> = processCommands,
): Promise<boolean> {
  const response = await fetchImplementation(
    "http://127.0.0.1:8787/health/ready",
    { signal: AbortSignal.timeout(4_000) },
  );
  return response.ok && requiredProcessesPresent(await commands());
}

async function main(): Promise<void> {
  if (!(await officeStackHealthy())) process.exitCode = 1;
}

if (
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main().catch(() => {
    process.exitCode = 1;
  });
}
