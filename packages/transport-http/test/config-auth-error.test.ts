import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  BearerAuthenticationEvidenceMapper,
  createProblemDetails,
  normalizeHttpServiceConfig,
  operationResultStatus,
} from "../src/index.js";

describe("HTTP service configuration", () => {
  it("provides bounded positive defaults", () => {
    const config = normalizeHttpServiceConfig({});

    for (const value of Object.values(config)) {
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
    expect(config.default_page_limit).toBeLessThanOrEqual(
      config.max_page_limit,
    );
    expect(config.sse_poll_interval_ms).toBeLessThan(
      config.sse_idle_timeout_ms,
    );
  });

  it.each([
    ["body_limit_bytes", 0],
    ["default_page_limit", -1],
    ["max_page_limit", 1.5],
    ["request_timeout_ms", Number.NaN],
    ["health_probe_timeout_ms", 0],
    ["sse_max_connections", Number.MAX_SAFE_INTEGER + 1],
    ["sse_poll_interval_ms", 0],
    ["sse_heartbeat_interval_ms", 0],
    ["sse_idle_timeout_ms", 0],
    ["shutdown_timeout_ms", 0],
  ] as const)("rejects unsafe %s", (field, value) => {
    expect(() => normalizeHttpServiceConfig({ [field]: value })).toThrow(
      new RegExp(field),
    );
  });

  it("rejects a default page limit above the maximum", () => {
    expect(() =>
      normalizeHttpServiceConfig({
        default_page_limit: 11,
        max_page_limit: 10,
      }),
    ).toThrow(/default_page_limit/);
  });
});

describe("Bearer authentication evidence", () => {
  const mapper = new BearerAuthenticationEvidenceMapper();

  it("maps one Bearer token without interpreting it", async () => {
    await expect(
      mapper.authenticationEvidence({
        authorization: "Bearer opaque-token",
        request_id: "request_01",
      }),
    ).resolves.toEqual({ bearer_token: "opaque-token" });
  });

  it.each([
    null,
    "",
    "Basic abc",
    "Bearer",
    "Bearer ",
    "Bearer token extra",
    "bearer token",
  ])("rejects absent or malformed authorization %j", async (authorization) => {
    await expect(
      mapper.authenticationEvidence({
        authorization,
        request_id: "request_01",
      }),
    ).resolves.toBeNull();
  });
});

describe("HTTP error mapping", () => {
  it.each([
    ["accepted", null, 200],
    ["rejected", "invalid_argument", 400],
    ["rejected", "unauthenticated", 401],
    ["rejected", "permission_denied", 403],
    ["rejected", "not_found", 404],
    ["rejected", "invalid_state_transition", 422],
    ["conflict", "version_conflict", 409],
    ["temporarily_unavailable", "temporarily_unavailable", 503],
  ] as const)("maps %s/%s to %i", (operation_status, code, expected) => {
    expect(
      operationResultStatus({
        operation_status,
        resource: operation_status === "accepted" ? {} : null,
        receipt: null,
        error: code === null ? null : { code },
      }),
    ).toBe(expected);
  });

  it("creates bounded RFC 9457 details without internal causes", () => {
    expect(
      createProblemDetails(400, "invalid_request", "Invalid request", {
        instance: "/v1/handoffs/handoff_01",
      }),
    ).toEqual({
      type: "urn:work-fabric:problem:invalid_request",
      title: "Invalid request",
      status: 400,
      code: "invalid_request",
      instance: "/v1/handoffs/handoff_01",
    });
  });

  it("keeps Fastify out of the public index", async () => {
    const source = await readFile(
      new URL("../src/index.ts", import.meta.url),
      "utf8",
    );
    expect(source.toLowerCase()).not.toContain("fastify");
    expect(source).not.toContain("./internal/");
  });
});
