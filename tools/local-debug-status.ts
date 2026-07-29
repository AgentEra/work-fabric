import {
  readLocalDebugState,
} from "./local-debug-common.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function healthy(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2_000) })).ok;
  } catch {
    return false;
  }
}

export async function localDebugStatus(
  input: Readonly<Record<string, string | undefined>> = process.env,
) {
  const state = await readLocalDebugState();
  const [service, channel] = await Promise.all([
    healthy("http://127.0.0.1:8787/health/ready"),
    healthy(
      input.WORK_FABRIC_DEBUG_HEALTH_URL
        ?? "http://127.0.0.1:8791/health",
    ),
  ]);
  return {
    service_ready: service,
    debug_channel_ready: channel,
    processes: state?.children.map((item) => ({
      ...item,
      alive: alive(item.pid),
    })) ?? [],
  };
}

if (
  process.argv[1] !== undefined
  && import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  void localDebugStatus().then((status) => {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    if (
      !status.service_ready
      || !status.debug_channel_ready
      || status.processes.some((item) => !item.alive)
    ) process.exitCode = 1;
  }).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Status check failed"}\n`,
    );
    process.exitCode = 1;
  });
}
