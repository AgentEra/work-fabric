import type { FastifyInstance, InjectOptions } from "fastify";

import type { HttpServiceConfig } from "./config.js";
import {
  createInternalServer,
  type InternalServerDependencies,
} from "./internal/create-server.js";
import type {
  HttpDispatchRequest,
  HttpDispatchResponse,
  HttpService,
} from "./public-types.js";

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
  constructor(private readonly server: FastifyInstance) {}

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
    await this.server.close();
  }
}

export function createHttpService(
  dependencies: InternalServerDependencies,
  config: HttpServiceConfig,
): HttpService {
  return new FastifyHttpService(createInternalServer(dependencies, config));
}
