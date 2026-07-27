import { provisionDailyAssistant } from "../examples/agently-agent-runtime/src/provision.js";
import { provisionFeishuProvider } from "../examples/feishu-capability-provider/src/provision.js";

import { prepareLocalFeishuEnvironment } from "./local-feishu-common.js";

export async function provisionLocalFeishu(
  input: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const environment = await prepareLocalFeishuEnvironment(input);
  await provisionDailyAssistant(environment);
  await provisionFeishuProvider(environment);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  void provisionLocalFeishu().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Local provisioning failed",
    );
    process.exitCode = 1;
  });
}
