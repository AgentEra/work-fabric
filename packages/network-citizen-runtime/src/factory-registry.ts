import type {
  NetworkCitizenFactory,
  NetworkCitizenKind,
} from "@work-fabric/network-citizen-spi";

const FACTORY_TYPE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;

export class NetworkCitizenFactoryRegistry {
  private readonly factories = new Map<string, NetworkCitizenFactory>();

  register(factory: NetworkCitizenFactory): void {
    if (
      !FACTORY_TYPE.test(factory.type) ||
      factory.type.length > 128
    ) {
      throw new TypeError("Network Citizen factory type is invalid");
    }
    if (this.factories.has(factory.type)) {
      throw new Error(`Network Citizen factory type is already registered: ${factory.type}`);
    }
    this.factories.set(factory.type, factory);
  }

  resolve(
    type: string,
    expectedKind: NetworkCitizenKind,
  ): NetworkCitizenFactory {
    const factory = this.factories.get(type);
    if (factory === undefined) {
      throw new Error(`Network Citizen factory type is not registered: ${type}`);
    }
    if (factory.citizen_kind !== expectedKind) {
      throw new Error(
        `Network Citizen factory kind mismatch: expected ${expectedKind}, received ${factory.citizen_kind}`,
      );
    }
    return factory;
  }
}
