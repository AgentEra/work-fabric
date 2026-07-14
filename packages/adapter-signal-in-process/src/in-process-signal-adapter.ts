import type {
  CapabilityManifest,
  ProtocolEvent,
  SignalAdapter,
  SignalDeliveryResult,
  SignalDestination,
} from "@work-fabric/exchange-spi";

interface RecordedDelivery {
  readonly event: ProtocolEvent;
  readonly destination: SignalDestination;
}

const manifest: CapabilityManifest = {
  profile: "exchange.signal.v1",
  adapter: "in-process",
  capabilities: {
    event_id_preservation: true,
    outcome_classification: true,
    payload_isolation: true,
  },
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InProcessSignalAdapter implements SignalAdapter {
  private readonly configuredOutcomes = new Map<string, SignalDeliveryResult>();
  private readonly recordedDeliveries: RecordedDelivery[] = [];

  get manifest(): CapabilityManifest {
    return clone(manifest);
  }

  setOutcome(eventId: string, result: SignalDeliveryResult): void {
    this.configuredOutcomes.set(eventId, clone(result));
  }

  async deliver(
    event: ProtocolEvent,
    destination: SignalDestination,
  ): Promise<SignalDeliveryResult> {
    const clonedEvent = clone(event);
    const clonedDestination = clone(destination);
    this.recordedDeliveries.push({
      event: clonedEvent,
      destination: clonedDestination,
    });
    return clone(this.configuredOutcomes.get(clonedEvent.id) ?? { kind: "accepted" });
  }

  deliveries(): readonly RecordedDelivery[] {
    return clone(this.recordedDeliveries);
  }
}
