import { CommandClient } from "./command-client.js";
import {
  normalizeClientOptions,
  normalizeRepresentationContext,
  type NormalizedClientOptions,
  type RepresentationContext,
  type WorkFabricClientOptions,
} from "./config.js";
import { HandoffClient } from "./handoff-client.js";
import { EndpointClient } from "./endpoint-client.js";
import { OperationsClient } from "./operations-client.js";
import { QueryClient } from "./query-client.js";
import { SubscriptionClient } from "./subscription-client.js";
import { SdkTransport } from "./transport.js";
import { CollaborationClient } from "./collaboration-client.js";
import type { AuthenticationProvider } from "./authentication.js";
import { DiscoveryClient } from "./discovery-client.js";

export class WorkFabricClient {
  readonly commands!: CommandClient;
  readonly handoffs!: HandoffClient;
  readonly queries!: QueryClient;
  readonly operations!: OperationsClient;
  readonly subscriptions!: SubscriptionClient;
  readonly endpoints!: EndpointClient;
  readonly collaboration!: CollaborationClient;
  readonly discovery!: DiscoveryClient;
  private readonly config!: NormalizedClientOptions;
  private readonly transport!: SdkTransport;
  private readonly representation!: Readonly<RepresentationContext>;

  constructor(options: WorkFabricClientOptions) {
    const config = normalizeClientOptions(options);
    return WorkFabricClient.compose(
      config,
      new SdkTransport(config),
      config.representation,
    );
  }

  withRepresentation(representation: RepresentationContext): WorkFabricClient {
    return WorkFabricClient.compose(
      this.config,
      this.transport,
      normalizeRepresentationContext(representation),
    );
  }

  withAuthentication(authentication: AuthenticationProvider): WorkFabricClient {
    const config = { ...this.config, authentication };
    return WorkFabricClient.compose(
      config,
      new SdkTransport(config),
      this.representation,
    );
  }

  private static compose(
    config: NormalizedClientOptions,
    transport: SdkTransport,
    representation: Readonly<RepresentationContext>,
  ): WorkFabricClient {
    const client = Object.create(WorkFabricClient.prototype) as WorkFabricClient;
    const commands = new CommandClient(transport, representation);
    Object.defineProperties(client, {
      config: { value: config },
      transport: { value: transport },
      representation: { value: representation },
      commands: { value: Object.freeze(commands), enumerable: true },
      handoffs: { value: Object.freeze(new HandoffClient(config, commands, representation)), enumerable: true },
      queries: { value: Object.freeze(new QueryClient(transport, representation)), enumerable: true },
      operations: { value: Object.freeze(new OperationsClient(transport, representation)), enumerable: true },
      subscriptions: { value: Object.freeze(new SubscriptionClient(config, transport, representation)), enumerable: true },
      endpoints: { value: Object.freeze(new EndpointClient(transport, representation)), enumerable: true },
      collaboration: { value: Object.freeze(new CollaborationClient(transport, representation)), enumerable: true },
      discovery: { value: Object.freeze(new DiscoveryClient(transport, representation)), enumerable: true },
    });
    return Object.freeze(client) as WorkFabricClient;
  }
}
