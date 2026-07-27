import { createFeishuProviderComposition } from "./composition.js";

export async function startFeishuProvider(
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const composition = await createFeishuProviderComposition(environment);
  try {
    await composition.start();
    return composition;
  } catch (error) {
    await composition.close();
    throw error;
  }
}

async function executable(): Promise<void> {
  const composition = await startFeishuProvider();
  const health = await composition.health();
  let closing: Promise<void> | null = null;
  const close = () => {
    closing ??= composition.close();
    return closing;
  };
  process.once("SIGINT", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });
  console.log(
    `Feishu Provider ready: capability=${health.capability_citizen}; context=${health.context_citizen}`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  void executable().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Feishu Provider startup failed",
    );
    process.exitCode = 1;
  });
}
