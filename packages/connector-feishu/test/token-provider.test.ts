import { describe, expect, it, vi } from "vitest";

import {
  FeishuTenantAccessTokenProvider,
  type FeishuAppCredentialProvider,
} from "../src/index.js";

describe("FeishuTenantAccessTokenProvider", () => {
  it("single-flights and caches a short-lived tenant token without exposing credentials", async () => {
    const credentials: FeishuAppCredentialProvider = {
      async loadAppCredentials() {
        return { app_id: "cli-app", app_secret: "do-not-log" };
      },
    };
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      msg: "ok",
      tenant_access_token: "tenant-token-1",
      expire: 7_200,
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof globalThis.fetch;
    const provider = new FeishuTenantAccessTokenProvider({
      credential_provider: credentials,
      fetch,
      base_url: "https://open.feishu.test",
      clock: { nowEpochSeconds: () => 1_000 },
      expiry_skew_seconds: 60,
      request_timeout_ms: 1_000,
    });

    await expect(Promise.all([
      provider.getToken("credential-ref-1"),
      provider.getToken("credential-ref-1"),
    ])).resolves.toEqual(["tenant-token-1", "tenant-token-1"]);
    expect(fetch).toHaveBeenCalledOnce();
    await expect(provider.getToken("credential-ref-1")).resolves.toBe("tenant-token-1");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("refreshes explicitly while keeping error details credential-free", async () => {
    let call = 0;
    const fetch = vi.fn(async () => {
      call += 1;
      return new Response(JSON.stringify(call === 1
        ? { code: 0, tenant_access_token: "token-1", expire: 7_200 }
        : { code: 10003, msg: "app credential invalid" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    const provider = new FeishuTenantAccessTokenProvider({
      credential_provider: {
        async loadAppCredentials() {
          return { app_id: "cli-app", app_secret: "super-secret-value" };
        },
      },
      fetch,
      base_url: "https://open.feishu.test",
      clock: { nowEpochSeconds: () => 1_000 },
      expiry_skew_seconds: 60,
      request_timeout_ms: 1_000,
    });
    await provider.getToken("credential-ref-1");
    await expect(provider.getToken("credential-ref-1", true)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error && !error.message.includes("super-secret-value"),
    );
  });
});
