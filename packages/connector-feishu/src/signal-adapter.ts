import { createHash } from "node:crypto";

import {
  SIGNAL_REQUIRED_CAPABILITIES,
  signalMediaTypeCapability,
  type ProtocolEvent,
  type SignalAdapter,
  type SignalDeliveryResult,
  type SignalDestination,
} from "@work-fabric/exchange-spi";

import {
  FeishuRenderError,
  parseFeishuDestination,
  type FeishuEventRenderer,
} from "./event-renderer.js";
import type { FeishuMessageClient } from "./open-api-client.js";

export interface FeishuSignalObserver {
  delivered(event: ProtocolEvent, destination: SignalDestination): void;
}

export interface FeishuSignalAdapterOptions {
  readonly messages: FeishuMessageClient;
  readonly renderer: FeishuEventRenderer;
  readonly observer?: FeishuSignalObserver;
}

function deliveryUuid(event: ProtocolEvent, destination: SignalDestination): string {
  return `wf_${createHash("sha256")
    .update(event.id)
    .update("\0")
    .update(destination.destination_id)
    .digest("base64url")}`;
}

export class FeishuSignalAdapter implements SignalAdapter {
  readonly manifest = {
    profile: "exchange.signal.v1",
    adapter: "feishu",
    capabilities: Object.fromEntries(
      [
        ...SIGNAL_REQUIRED_CAPABILITIES,
        signalMediaTypeCapability("text/plain"),
        signalMediaTypeCapability("text/markdown"),
      ].map((capability) => [capability, true]),
    ),
  } as const;

  constructor(private readonly options: FeishuSignalAdapterOptions) {}

  async deliver(
    event: ProtocolEvent,
    destination: SignalDestination,
  ): Promise<SignalDeliveryResult> {
    const safeEvent = structuredClone(event);
    const safeDestination = structuredClone(destination);
    this.options.observer?.delivered(safeEvent, safeDestination);
    try {
      if (safeDestination.binding !== "feishu") {
        return { kind: "permanent_failure", detail: "unsupported_binding" };
      }
      const configuration = parseFeishuDestination(
        safeDestination.configuration as Record<string, unknown>,
      );
      const rendered = this.options.renderer.render(safeEvent, configuration);
      const result = await this.options.messages.sendMessage({
        credential_ref: configuration.credential_ref,
        receive_id_type: configuration.receive_id_type,
        receive_id: configuration.receive_id,
        msg_type: rendered.msg_type,
        content: rendered.content,
        uuid: deliveryUuid(safeEvent, safeDestination),
      });
      if (result.kind === "accepted") return { kind: "accepted" };
      return { kind: result.kind, detail: result.error_code.slice(0, 512) };
    } catch (error) {
      if (error instanceof FeishuRenderError) {
        return { kind: "permanent_failure", detail: error.code };
      }
      return error instanceof TypeError || error instanceof RangeError
        ? { kind: "permanent_failure", detail: "invalid_feishu_destination" }
        : { kind: "retryable_failure", detail: "feishu_adapter_failure" };
    }
  }
}
