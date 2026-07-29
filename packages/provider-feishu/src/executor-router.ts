import type {
  FeishuCapabilityExecutionRequest,
  FeishuCapabilityOutcome,
} from "./contracts.js";
import type {
  FeishuCapabilityExecutorLike,
} from "./execution-adapter.js";

export interface FeishuCapabilityExecutionRoute {
  readonly capability_ids: readonly string[];
  readonly executor: FeishuCapabilityExecutorLike;
}

export class FeishuCapabilityExecutorRouter
  implements FeishuCapabilityExecutorLike {
  private readonly routes: ReadonlyMap<string, FeishuCapabilityExecutorLike>;

  constructor(routes: readonly FeishuCapabilityExecutionRoute[]) {
    const byCapability = new Map<string, FeishuCapabilityExecutorLike>();
    for (const route of routes) {
      if (route.capability_ids.length === 0) {
        throw new TypeError("Feishu capability route is empty");
      }
      for (const capabilityId of route.capability_ids) {
        if (
          capabilityId.length === 0 ||
          byCapability.has(capabilityId)
        ) {
          throw new TypeError("Feishu capability route is invalid");
        }
        byCapability.set(capabilityId, route.executor);
      }
    }
    if (byCapability.size === 0) {
      throw new TypeError("Feishu capability routes are empty");
    }
    this.routes = byCapability;
  }

  execute(
    request: FeishuCapabilityExecutionRequest,
  ): Promise<FeishuCapabilityOutcome> {
    const executor = this.routes.get(request.capability_id);
    if (executor === undefined) {
      return Promise.resolve({
        outcome: "rejected",
        code: "unsupported_capability",
        message: "Feishu capability is unavailable",
        retryable: false,
      });
    }
    return executor.execute(request);
  }
}
