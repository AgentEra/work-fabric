import { isAbortError, linkedAbortSignal } from "./abort.js";
import type {
  NormalizedClientOptions,
  RepresentationContext,
} from "./config.js";
import {
  WorkFabricHttpError,
  WorkFabricTransportError,
  type ProblemDetails,
} from "./errors.js";
import { abortableSleep, retryDelay, type Sleep } from "./retry.js";

type QueryValue = string | number | boolean | null | undefined;

export interface TransportRequest<T> {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: readonly string[];
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  readonly retry: "query" | "none";
  readonly representation?: RepresentationContext | null;
  readonly headers?: Readonly<Record<string, string>>;
  readonly decode: (value: unknown) => T;
}

interface TransportInternals {
  readonly sleep?: Sleep;
  readonly random?: () => number;
}

function encodedUrl(
  baseUrl: URL,
  path: readonly string[],
  query: Readonly<Record<string, QueryValue>> | undefined,
): URL {
  if (path.length === 0 || path.some((segment) => segment.length === 0)) {
    throw new TypeError("path must contain non-empty segments");
  }
  const url = new URL(path.map(encodeURIComponent).join("/"), baseUrl);
  if (query !== undefined) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== null && value !== undefined) {
        url.searchParams.append(key, String(value));
      }
    }
  }
  return url;
}

function problemDetails(value: unknown, status: number): ProblemDetails {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Problem Details must be an object");
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.type !== "string" ||
    typeof candidate.title !== "string" ||
    candidate.status !== status ||
    typeof candidate.code !== "string" ||
    (candidate.instance !== undefined && typeof candidate.instance !== "string")
  ) {
    throw new TypeError("Problem Details is invalid");
  }
  return {
    type: candidate.type,
    title: candidate.title,
    status,
    code: candidate.code,
    ...(candidate.instance === undefined ? {} : { instance: candidate.instance }),
  };
}

function transportFailure(
  code: "network_error" | "timeout" | "aborted" | "invalid_response" | "redirect_rejected",
): WorkFabricTransportError {
  const messages = {
    network_error: "The Work Fabric service could not be reached",
    timeout: "The Work Fabric request timed out",
    aborted: "The Work Fabric request was aborted",
    invalid_response: "The Work Fabric service returned an invalid response",
    redirect_rejected: "The Work Fabric service returned an unsafe redirect",
  } as const;
  return new WorkFabricTransportError(code, messages[code]);
}

export class SdkTransport {
  private readonly sleep: Sleep;
  private readonly random: () => number;

  constructor(
    private readonly config: NormalizedClientOptions,
    internals: TransportInternals = {},
  ) {
    this.sleep = internals.sleep ?? abortableSleep;
    this.random = internals.random ?? Math.random;
  }

  async request<T>(input: TransportRequest<T>): Promise<T> {
    const url = encodedUrl(this.config.baseUrl, input.path, input.query);
    const linked = linkedAbortSignal(input.signal, this.config.requestTimeoutMs);
    const canRetry = input.method === "GET" && input.retry === "query";
    let retryIndex = 0;

    try {
      while (true) {
        let response: Response;
        try {
          const authorization = await this.config.authentication.getAuthorization({
            method: input.method,
            url: url.toString(),
            signal: linked.signal,
          });
          const headers = new Headers(input.headers);
          headers.set("accept", "application/json");
          if (authorization !== null) {
            headers.set("authorization", authorization);
          }
          const representation =
            input.representation === undefined
              ? this.config.representation
              : input.representation;
          if (representation !== null) {
            headers.set("x-wf-actor-id", representation.actorId);
            headers.set("x-wf-endpoint-id", representation.endpointId);
            if (representation.delegationId !== undefined) {
              headers.set("x-wf-delegation-id", representation.delegationId);
            }
          }
          const requestInit: RequestInit = {
            method: input.method,
            headers,
            redirect: "manual",
            signal: linked.signal,
            ...(input.body === undefined
              ? {}
              : {
                  body: JSON.stringify(input.body),
                }),
          };
          if (input.body !== undefined) {
            headers.set("content-type", "application/json");
          }
          linked.signal.throwIfAborted();
          response = await this.config.fetch(url, requestInit);
        } catch (error) {
          if (linked.signal.aborted || isAbortError(error)) {
            throw transportFailure(linked.didTimeout() ? "timeout" : "aborted");
          }
          if (canRetry && retryIndex < this.config.queryRetry.maxRetries) {
            const delay = retryDelay(
              retryIndex,
              this.config.queryRetry,
              this.random,
              null,
            );
            retryIndex += 1;
            await this.sleep(delay, linked.signal);
            continue;
          }
          throw transportFailure("network_error");
        }

        if (
          response.status === 0 ||
          (response.status >= 300 && response.status < 400) ||
          (response.url !== "" && new URL(response.url).origin !== url.origin)
        ) {
          throw transportFailure("redirect_rejected");
        }

        if (
          canRetry &&
          (response.status === 429 || response.status === 503) &&
          retryIndex < this.config.queryRetry.maxRetries
        ) {
          const delay = retryDelay(
            retryIndex,
            this.config.queryRetry,
            this.random,
            response.headers.get("retry-after"),
          );
          retryIndex += 1;
          await this.sleep(delay, linked.signal);
          continue;
        }

        let value: unknown;
        try {
          value = JSON.parse(await response.text()) as unknown;
        } catch {
          throw transportFailure("invalid_response");
        }

        if (!response.ok) {
          try {
            throw new WorkFabricHttpError(
              problemDetails(value, response.status),
              response.headers.get("x-request-id"),
            );
          } catch (error) {
            if (error instanceof WorkFabricHttpError) {
              throw error;
            }
            throw transportFailure("invalid_response");
          }
        }

        try {
          return input.decode(value);
        } catch {
          throw transportFailure("invalid_response");
        }
      }
    } catch (error) {
      if (error instanceof WorkFabricTransportError && linked.signal.aborted) {
        if (error.code !== "timeout" && error.code !== "aborted") {
          throw transportFailure(linked.didTimeout() ? "timeout" : "aborted");
        }
      }
      if (isAbortError(error)) {
        throw transportFailure(linked.didTimeout() ? "timeout" : "aborted");
      }
      throw error;
    } finally {
      linked.cleanup();
    }
  }
}
