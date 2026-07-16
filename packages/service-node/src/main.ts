import { readFile } from "node:fs/promises";

import {
  composeNodeService,
  type NodeServiceCompositionOptions,
} from "./compose.js";
import { parseServiceConfig } from "./config.js";

export async function runNodeService(
  environment: NodeJS.ProcessEnv = process.env,
  composition: NodeServiceCompositionOptions = {},
): Promise<void> {
  const configPath = environment.WORK_FABRIC_CONFIG;
  if (configPath === undefined || configPath.trim() === "") {
    throw new Error("WORK_FABRIC_CONFIG must point to an explicit JSON configuration file");
  }
  const config = parseServiceConfig(JSON.parse(await readFile(configPath, "utf8")));
  const service = await composeNodeService(config, composition);
  service.start();
  if (config.role === "api" || config.role === "all") {
    const { origin } = await service.listen();
    process.stdout.write(`Work Fabric listening at ${origin}\n`);
    const shutdown = () => { void service.close(); };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return;
  }
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
