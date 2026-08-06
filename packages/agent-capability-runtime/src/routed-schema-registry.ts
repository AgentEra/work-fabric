import type { InvocationSchemaRegistry } from "./contracts.js";
import type { CitizenSchemaReference } from "@work-fabric/network-citizen-spi";

export interface InvocationSchemaRegistryRoute {
  readonly uri_prefix: string;
  readonly registry: InvocationSchemaRegistry;
}

export class RoutedInvocationSchemaRegistry
implements InvocationSchemaRegistry {
  private readonly routes: readonly InvocationSchemaRegistryRoute[];

  constructor(
    routes: readonly InvocationSchemaRegistryRoute[],
  ) {
    if (
      !Array.isArray(routes)
      || routes.length === 0
      || routes.some((route) =>
        typeof route.uri_prefix !== "string"
        || route.uri_prefix.length === 0
        || route.registry === null
        || typeof route.registry !== "object"
        || typeof route.registry.load !== "function"
      )
    ) {
      throw new TypeError("Invocation schema Registry routes are invalid");
    }
    for (const [index, route] of routes.entries()) {
      if (routes.some((candidate, candidateIndex) =>
        candidateIndex !== index
        && (
          candidate.uri_prefix.startsWith(route.uri_prefix)
          || route.uri_prefix.startsWith(candidate.uri_prefix)
        )
      )) {
        throw new TypeError("Invocation schema Registry routes overlap");
      }
    }
    this.routes = Object.freeze(routes.map((route) => Object.freeze({
      uri_prefix: route.uri_prefix,
      registry: route.registry,
    })));
  }

  async load(
    reference: CitizenSchemaReference,
    signal: AbortSignal,
  ): Promise<unknown> {
    const route = this.routes.find((candidate) =>
      reference.uri.startsWith(candidate.uri_prefix)
    );
    if (route === undefined) {
      throw new TypeError("No invocation schema Registry owns this URI");
    }
    return route.registry.load(reference, signal);
  }
}
