import { loadGitHubProviderConfiguration } from "./configuration.js";
import { composeGitHubProvider } from "./composition.js";

export async function startGitHubProvider(
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const loaded = await loadGitHubProviderConfiguration({ environment });
  const composition = await composeGitHubProvider(loaded, environment);
  try {
    await composition.start();
    return composition;
  } catch (error) {
    await composition.close();
    throw error;
  }
}

async function executable(): Promise<void> {
  const composition = await startGitHubProvider();
  const close = () => composition.close();
  process.once("SIGINT", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });
  const health = await composition.health();
  console.log(`GitHub Provider ready: citizen=${health.citizen}`);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void executable().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "GitHub Provider startup failed");
    process.exitCode = 1;
  });
}
