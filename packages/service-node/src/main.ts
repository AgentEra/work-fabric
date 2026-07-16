import { readFile } from "node:fs/promises";

import { composeNodeService } from "./compose.js";
import { parseServiceConfig } from "./config.js";

export async function runNodeService(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const configPath = environment.WORK_FABRIC_CONFIG;
  if (configPath === undefined || configPath.trim() === "") {
    throw new Error("WORK_FABRIC_CONFIG must point to an explicit JSON configuration file");
  }
  const config = parseServiceConfig(JSON.parse(await readFile(configPath, "utf8")));
  const service = await composeNodeService(config);
  if (config.role === "api" || config.role === "all") {
    const { origin } = await service.listen();
    process.stdout.write(`Work Fabric listening at ${origin}\n`);
    const shutdown = () => { void service.close(); };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return;
  }
  if (config.role === "projector") {
    const partition = environment.WORK_FABRIC_PARTITION;
    if (partition === undefined || partition.trim() === "") {
      await service.close();
      throw new Error("WORK_FABRIC_PARTITION is required for a projector turn");
    }
    await service.runProjection(partition, 1_000);
  }
  await service.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runNodeService().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
