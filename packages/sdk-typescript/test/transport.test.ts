import { describe, expect, it, vi } from "vitest";

import { BearerTokenProvider, WorkFabricHttpError, WorkFabricTransportError } from "../src/index.js";
import { normalizeClientOptions } from "../src/config.js";
import { SdkTransport } from "../src/transport.js";

function config(
  fetch: typeof globalThis.fetch,
  options: {
    readonly authentication?: BearerTokenProvider;
    readonly requestTimeoutMs?: number;
    readonly maxRetries?: number;
  } = {},
) {
  return normalizeClientOptions({
    baseUrl: "https://fabric.example.test/api",
    tenantId: "tenant_01",
    exchangeId: "exchange_01",
    representation: {
      actorId: "actor_01",
      endpointId: "endpoint_01",
      delegationId: "delegation_01",
    },
    authentication: options.authentication ?? new BearerTokenProvider("token"),
    fetch,
    requestTimeoutMs: options.requestTimeoutMs ?? 100,
    queryRetry: {
      maxRetries: options.maxRetries ?? 2,
      baseDelayMs: 10,
      maxDelayMs: 20,
      maxRetryAfterMs: 50,
    },
  });
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("SdkTransport", () => {
  it("builds encoded URLs, refreshes authentication per attempt, and applies representation headers", async () => {
    let tokenCalls = 0;
    const authentication = new BearerTokenProvider(async () => {
      tokenCalls += 1;
      return `token-${tokenCalls}`;
    });
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init: init ?? {} });
      if (requests.length === 1) {
        return json(
          {
            type: "urn:work-fabric:problem:temporarily_unavailable",
            title: "Unavailable",
            status: 503,
            code: "temporarily_unavailable",
          },
          503,
        );
      }
      return json({ value: "ok" }, 200, { "x-request-id": "request_02" });
    }) as unknown as typeof globalThis.fetch;
    const sleeps: number[] = [];
    const transport = new SdkTransport(config(fetch, { authentication }), {
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
      random: () => 1,
    });

    const result = await transport.request({
      method: "GET",
      path: ["v1", "handoffs", "id with/slash"],
      query: { from_version: 1, tag: "a b" },
      retry: "query",
      decode: (value) => value as { value: string },
    });

    expect(result).toEqual({ value: "ok" });
    expect(tokenCalls).toBe(2);
    expect(sleeps).toEqual([10]);
    expect(requests[0]?.url).toBe(
      "https://fabric.example.test/api/v1/handoffs/id%20with%2Fslash?from_version=1&tag=a+b",
    );
    expect(new Headers(requests[1]?.init.headers).get("authorization")).toBe(
      "Bearer token-2",
    );
    expect(new Headers(requests[1]?.init.headers).get("x-wf-actor-id")).toBe(
      "actor_01",
    );
    expect(new Headers(requests[1]?.init.headers).get("x-wf-endpoint-id")).toBe(
      "endpoint_01",
    );
    expect(new Headers(requests[1]?.init.headers).get("x-wf-delegation-id")).toBe(
      "delegation_01",
    );
    expect(requests[1]?.init.redirect).toBe("manual");
  });

  it("sends canonical JSON and never retries POST", async () => {
    const fetchMock = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => {
      throw new Error("network secret");
    });
    const fetch = fetchMock as unknown as typeof globalThis.fetch;
    const sleeps = vi.fn(async () => {});
    const transport = new SdkTransport(config(fetch), {
      sleep: sleeps,
      random: () => 0,
    });

    await expect(
      transport.request({
        method: "POST",
        path: ["v1", "commands"],
        body: { hello: "world" },
        retry: "none",
        decode: (value) => value,
      }),
    ).rejects.toMatchObject({ code: "network_error" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(sleeps).not.toHaveBeenCalled();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ hello: "world" }));
  });

  it("maps bounded Problem Details and request ID", async () => {
    const fetch = vi.fn(async () =>
      json(
        {
          type: "urn:work-fabric:problem:permission_denied",
          title: "Permission denied",
          status: 403,
          code: "permission_denied",
          instance: "/v1/handoffs/handoff_01",
        },
        403,
        { "x-request-id": "request_denied" },
      ),
    ) as unknown as typeof globalThis.fetch;
    const transport = new SdkTransport(config(fetch));

    const error = await transport
      .request({
        method: "GET",
        path: ["v1", "handoffs", "handoff_01"],
        retry: "query",
        decode: (value) => value,
      })
      .catch((candidate: unknown) => candidate);
    expect(error).toBeInstanceOf(WorkFabricHttpError);
    expect(error).toMatchObject({
      status: 403,
      code: "permission_denied",
      requestId: "request_denied",
    });
  });

  it.each([
    [new Response(null, { status: 302, headers: { location: "https://evil.test" } }), "redirect_rejected"],
    [json("not-an-object"), "invalid_response"],
    [new Response("{", { status: 200, headers: { "content-type": "application/json" } }), "invalid_response"],
  ] as const)("rejects redirect or invalid success responses", async (response, code) => {
    const fetch = vi.fn(async () => response.clone()) as unknown as typeof globalThis.fetch;
    const transport = new SdkTransport(config(fetch));

    await expect(
      transport.request({
        method: "GET",
        path: ["v1", "handoffs", "handoff_01"],
        retry: "query",
        decode(value) {
          if (typeof value !== "object" || value === null || Array.isArray(value)) {
            throw new TypeError("not an object");
          }
          return value;
        },
      }),
    ).rejects.toMatchObject({ code });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects a final Origin mismatch", async () => {
    const response = json({ ok: true });
    Object.defineProperty(response, "url", {
      value: "https://other.example.test/v1/handoffs/one",
    });
    const fetch = vi.fn(async () => response) as unknown as typeof globalThis.fetch;
    const transport = new SdkTransport(config(fetch));

    await expect(
      transport.request({
        method: "GET",
        path: ["v1", "handoffs", "one"],
        retry: "query",
        decode: (value) => value,
      }),
    ).rejects.toMatchObject({ code: "redirect_rejected" });
  });

  it("distinguishes timeout from external Abort and clears request work", async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    ) as unknown as typeof globalThis.fetch;
    const timed = new SdkTransport(config(fetch, { requestTimeoutMs: 5 }));
    await expect(
      timed.request({
        method: "GET",
        path: ["health", "ready"],
        retry: "none",
        decode: (value) => value,
      }),
    ).rejects.toMatchObject({ code: "timeout" });

    const controller = new AbortController();
    const aborted = new SdkTransport(config(fetch, { requestTimeoutMs: 100 }));
    const pending = aborted.request({
      method: "GET",
      path: ["health", "ready"],
      signal: controller.signal,
      retry: "none",
      decode: (value) => value,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });

  it("honors bounded Retry-After and retries only 429/503/network failures", async () => {
    const responses = [
      json({ type: "x", title: "Rate limited", status: 429, code: "rate_limited" }, 429, {
        "retry-after": "999",
      }),
      json({ ok: true }),
    ];
    const fetch = vi.fn(async () => responses.shift() ?? json({ ok: true })) as unknown as typeof globalThis.fetch;
    const sleeps: number[] = [];
    const transport = new SdkTransport(config(fetch), {
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
      random: () => 0.5,
    });

    await expect(
      transport.request({
        method: "GET",
        path: ["health", "ready"],
        retry: "query",
        representation: null,
        decode: (value) => value,
      }),
    ).resolves.toEqual({ ok: true });
    expect(sleeps).toEqual([50]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not expose an authentication value or transport cause in errors", async () => {
    const secret = "super-secret-token";
    const fetch = vi.fn(async () => {
      throw new Error(`socket failed while using ${secret}`);
    }) as unknown as typeof globalThis.fetch;
    const transport = new SdkTransport(
      config(fetch, { authentication: new BearerTokenProvider(secret), maxRetries: 0 }),
    );

    const error = await transport
      .request({
        method: "GET",
        path: ["health", "ready"],
        retry: "query",
        decode: (value) => value,
      })
      .catch((candidate: unknown) => candidate);
    expect(error).toBeInstanceOf(WorkFabricTransportError);
    if (!(error instanceof WorkFabricTransportError)) {
      throw new TypeError("expected transport error");
    }
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain("socket");
  });
});
