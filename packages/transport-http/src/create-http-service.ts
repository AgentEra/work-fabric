import type { FastifyInstance, InjectOptions } from "fastify";

import type { HttpServiceConfig } from "./config.js";
import { HealthService } from "./health-service.js";
import {
  createInternalServer,
  type InternalServerDependencies,
} from "./internal/create-server.js";
import type {
  HttpDispatchRequest,
  HttpDispatchResponse,
  HttpService,
} from "./public-types.js";
import { SseConnectionManager } from "./sse-connection-manager.js";

function headers(
  input: Readonly<Record<string, string | string[] | number | undefined>>,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (value !== undefined) {
      result[name.toLowerCase()] = Array.isArray(value)
        ? value.join(", ")
        : String(value);
    }
  }
  return result;
}

class FastifyHttpService implements HttpService {
  private closing: Promise<void> | null = null;

  constructor(
    private readonly server: FastifyInstance,
    private readonly health: HealthService,
    private readonly sseConnections: SseConnectionManager,
    private readonly shutdownTimeoutMs: number,
  ) {}

  async dispatch(request: HttpDispatchRequest): Promise<HttpDispatchResponse> {
    const options: InjectOptions = {
      method: request.method,
      url: request.url,
      ...(request.headers === undefined ? {} : { headers: request.headers }),
      ...(request.payload === undefined
        ? {}
        : {
            payload: (request.payload === null
              ? "null"
              : request.payload) as NonNullable<InjectOptions["payload"]>,
          }),
    };
    const response = await this.server.inject(options);
    return {
      status_code: response.statusCode,
      headers: headers(response.headers),
      body: response.body,
      json: () => response.json(),
    };
  }

  async listen(options: { readonly host: string; readonly port: number }) {
    const origin = await this.server.listen(options);
    return { origin };
  }

  async close(): Promise<void> {
    if (this.closing !== null) return this.closing;
    this.health.beginShutdown();
    this.sseConnections.beginShutdown();
    this.closing = new Promise<void>((resolve) => {
      let completed = false;
      const complete = () => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.server.server.closeAllConnections();
        complete();
      }, this.shutdownTimeoutMs);
      void this.server.close().then(complete, complete);
    });
    return this.closing;
  }
}

export function createHttpService(
  dependencies: InternalServerDependencies,
  config: HttpServiceConfig,
): HttpService {
  const health = new HealthService(
    dependencies.health_probes ?? [],
    config.health_probe_timeout_ms,
  );
  const sseConnections = new SseConnectionManager(config.sse_max_connections);
  const server = createInternalServer(
    { ...dependencies, health, sse_connections: sseConnections },
    config,
  );
  return new FastifyHttpService(
    server,
    health,
    sseConnections,
    config.shutdown_timeout_ms,
  );
}
