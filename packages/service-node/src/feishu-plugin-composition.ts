import {
  validateFeishuPluginConfig,
} from "@work-fabric/plugin-channel-feishu";
import type { PluginHostConfiguration } from "@work-fabric/plugin-runtime";

export function assertFeishuPluginRole(
  role: "api" | "worker" | "all",
  plugins: PluginHostConfiguration,
): void {
  for (const instance of Object.values(plugins)) {
    if (!instance.enabled || instance.type !== "collaboration-channel.feishu") {
      continue;
    }
    const config = validateFeishuPluginConfig(instance.config);
    if (
      role === "worker"
      && config.inbound.enabled
      && config.inbound.transport === "long_connection"
    ) {
      throw new Error("feishu_long_connection_requires_api_role");
    }
  }
}
