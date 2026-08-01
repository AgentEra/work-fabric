import {
  composeNodeService,
  type NodeServiceCompositionOptions,
} from "./compose.js";
import { loadNodeConfiguration } from "./configuration-loader.js";

export async function startListeningNodeService(
  service: Awaited<ReturnType<typeof composeNodeService>>,
): Promise<void> {
  try {
    await service.start();
  } catch (error) {
    await service.close().catch(() => undefined);
    throw error;
  }
}

export async function runNodeService(
  environment: NodeJS.ProcessEnv = process.env,
  composition: NodeServiceCompositionOptions = {},
): Promise<void> {
  const loaded = await loadNodeConfiguration(environment);
  const config = loaded.service;
  const service = await composeNodeService(config, {
    ...composition,
    configuration_revision: loaded.revision,
    plugins: loaded.plugins,
    admission: loaded.admission,
    agent_runtime_authority: loaded.agent_runtime_authority,
  });
  if (config.role === "api" || config.role === "all") {
    const { origin } = await service.listen();
    await startListeningNodeService(service);
    process.stdout.write(`Work Fabric listening at ${origin}\n`);
    const shutdown = () => { void service.close(); };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return;
  }
  await service.start();
  process.stdout.write("Work Fabric cluster worker started\n");
  const shutdown = () => { void service.close(); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runNodeService().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
