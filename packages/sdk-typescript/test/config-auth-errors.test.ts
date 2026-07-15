import { readFile, readdir } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  BearerTokenProvider,
  WorkFabricHttpError,
  WorkFabricTransportError,
} from "../src/index.js";
import { normalizeClientOptions } from "../src/config.js";

const representation = {
  actorId: "actor_01",
  endpointId: "endpoint_01",
  delegationId: "delegation_01",
};

describe("SDK configuration", () => {
  it("normalizes a safe absolute base URL and freezes copied representation", () => {
    const source = { ...representation };
    const config = normalizeClientOptions({
      baseUrl: "https://fabric.example.test/root",
      tenantId: "tenant_01",
      exchangeId: "exchange_01",
      representation: source,
      authentication: new BearerTokenProvider("token"),
    });

    expect(config.baseUrl.href).toBe("https://fabric.example.test/root/");
    expect(config.baseUrl.origin).toBe("https://fabric.example.test");
    expect(config.representation).toEqual(representation);
    expect(Object.isFrozen(config.representation)).toBe(true);
    source.actorId = "actor_changed";
    expect(config.representation.actorId).toBe("actor_01");
    expect(config.requestTimeoutMs).toBeGreaterThan(0);
    expect(config.queryRetry.maxRetries).toBe(2);
    expect(config.streamReconnect.maxReconnects).toBe(5);
  });

  it.each([
    "relative/path",
    "ftp://fabric.example.test",
    "https://user:password@fabric.example.test",
    "https://fabric.example.test?tenant=bad",
    "https://fabric.example.test#fragment",
  ])("rejects unsafe base URL %s", (baseUrl) => {
    expect(() =>
      normalizeClientOptions({
        baseUrl,
        tenantId: "tenant_01",
        exchangeId: "exchange_01",
        representation,
        authentication: new BearerTokenProvider("token"),
      }),
    ).toThrow(/baseUrl/);
  });

  it.each([
    ["requestTimeoutMs", 0],
    ["queryRetry.maxRetries", -1],
    ["queryRetry.baseDelayMs", 0],
    ["queryRetry.maxDelayMs", Number.NaN],
    ["queryRetry.maxRetryAfterMs", Number.MAX_SAFE_INTEGER + 1],
    ["streamReconnect.maxReconnects", -1],
    ["streamReconnect.baseDelayMs", 0],
    ["streamReconnect.maxDelayMs", 0],
    ["streamReconnect.maxFrameBytes", 0],
  ] as const)("rejects unsafe %s", (path, value) => {
    const [group, field] = path.split(".");
    const options =
      group === "queryRetry"
        ? { queryRetry: { [field as string]: value } }
        : group === "streamReconnect"
          ? { streamReconnect: { [field as string]: value } }
          : { [group as string]: value };
    expect(() =>
      normalizeClientOptions({
        baseUrl: "https://fabric.example.test",
        tenantId: "tenant_01",
        exchangeId: "exchange_01",
        representation,
        authentication: new BearerTokenProvider("token"),
        ...options,
      }),
    ).toThrow(new RegExp(field ?? group ?? "config"));
  });

  it.each(["tenantId", "exchangeId", "actorId", "endpointId"] as const)(
    "rejects an empty %s",
    (field) => {
    expect(() =>
      normalizeClientOptions({
        baseUrl: "https://fabric.example.test",
        tenantId: field === "tenantId" ? "" : "tenant_01",
        exchangeId: field === "exchangeId" ? "" : "exchange_01",
        representation: {
          actorId: field === "actorId" ? "" : "actor_01",
          endpointId: field === "endpointId" ? "" : "endpoint_01",
        },
        authentication: new BearerTokenProvider("token"),
      }),
    ).toThrow(new RegExp(field));
    },
  );
});

describe("authentication", () => {
  it("supports static and refreshing Bearer tokens", async () => {
    const staticProvider = new BearerTokenProvider("static-token");
    let calls = 0;
    const refreshing = new BearerTokenProvider(async () => {
      calls += 1;
      return `refresh-${calls}`;
    });
    const input = {
      method: "GET",
      url: "https://fabric.example.test/v1/handoffs/one",
      signal: new AbortController().signal,
    };

    await expect(staticProvider.getAuthorization(input)).resolves.toBe(
      "Bearer static-token",
    );
    await expect(refreshing.getAuthorization(input)).resolves.toBe(
      "Bearer refresh-1",
    );
    await expect(refreshing.getAuthorization(input)).resolves.toBe(
      "Bearer refresh-2",
    );
  });

  it.each(["", " ", "token with space", "x".repeat(4097)])(
    "rejects unsafe tokens without echoing them",
    async (token) => {
      const provider = new BearerTokenProvider(token);
      await expect(
        provider.getAuthorization({
          method: "GET",
          url: "https://fabric.example.test",
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("Bearer token is invalid");
    },
  );
});

describe("safe SDK errors", () => {
  it("retains bounded machine-readable fields", () => {
    const problem = {
      type: "urn:work-fabric:problem:permission_denied",
      title: "Permission denied",
      status: 403,
      code: "permission_denied",
      instance: "/v1/handoffs/handoff_01",
    };
    const http = new WorkFabricHttpError(problem, "request_01");
    const transport = new WorkFabricTransportError(
      "network_error",
      "Work Fabric request failed",
      "request_02",
      new Error("socket"),
    );

    expect(http).toMatchObject({
      status: 403,
      code: "permission_denied",
      requestId: "request_01",
      problem,
    });
    expect(transport).toMatchObject({
      code: "network_error",
      requestId: "request_02",
    });
    expect(http.message).toBe("Permission denied");
    expect(transport.message).not.toContain("socket");
  });

  it("keeps server and Node implementation imports out of the public index", async () => {
    const directory = new URL("../src/", import.meta.url);
    const files = (await readdir(directory)).filter((file) => file.endsWith(".ts"));
    const source = (await Promise.all(
      files.map((file) => readFile(new URL(file, directory), "utf8")),
    )).join("\n");
    expect(source).not.toMatch(
      /(?:from\s+["'](?:fastify|node:|@work-fabric\/adapter-|@work-fabric\/transport-http)|exchange-application|handoff-decider)/i,
    );
  });
});
