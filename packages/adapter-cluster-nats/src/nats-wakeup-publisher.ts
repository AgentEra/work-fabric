import type {
  ClusterCapabilityManifest,
  PartitionWakeup,
  PartitionWakeupPublisher,
} from "@work-fabric/cluster-spi";

import { natsWakeupManifest } from "./manifest.js";
import type { WakeupJetStreamPort } from "./nats-port.js";
import type { HmacWakeupSubjectCodec } from "./subject-codec.js";
import { encodeWakeup } from "./wakeup-codec.js";

export interface NatsWakeupPublisherOptions {
  readonly port: WakeupJetStreamPort;
  readonly subjects: HmacWakeupSubjectCodec;
}

export class NatsWakeupPublisher implements PartitionWakeupPublisher {
  constructor(private readonly options: NatsWakeupPublisherOptions) {}

  get manifest(): ClusterCapabilityManifest {
    return natsWakeupManifest();
  }

  async publish(
    wakeup: PartitionWakeup,
  ): Promise<"accepted" | "retryable_failure"> {
    const payload = encodeWakeup(wakeup);
    const subject = this.options.subjects.subjectFor(wakeup);
    try {
      await this.options.port.publish({
        subject,
        payload,
        message_id: wakeup.wakeup_id,
      });
      return "accepted";
    } catch {
      return "retryable_failure";
    }
  }
}
