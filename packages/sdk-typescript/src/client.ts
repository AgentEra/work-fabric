import { CommandClient } from "./command-client.js";
import {
  normalizeClientOptions,
  normalizeRepresentationContext,
  type NormalizedClientOptions,
  type RepresentationContext,
  type WorkFabricClientOptions,
} from "./config.js";
import { HandoffClient } from "./handoff-client.js";
import { OperationsClient } from "./operations-client.js";
import { QueryClient } from "./query-client.js";
import { SdkTransport } from "./transport.js";

export class WorkFabricClient {
  readonly commands!: CommandClient;
  readonly handoffs!: HandoffClient;
  readonly queries!: QueryClient;
  readonly operations!: OperationsClient;
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
    });
    return Object.freeze(client) as WorkFabricClient;
  }
}
