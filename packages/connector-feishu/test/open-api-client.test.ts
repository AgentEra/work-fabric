import { describe, expect, it, vi } from "vitest";

import {
  FeishuOpenApiClient,
  type FeishuTenantTokenProvider,
} from "../src/index.js";

class Tokens implements FeishuTenantTokenProvider {
  readonly calls: boolean[] = [];
  async getToken(_reference: string, forceRefresh = false): Promise<string> {
    this.calls.push(forceRefresh);
    return forceRefresh ? "token-2" : "token-1";
  }
}

const message = {
  credential_ref: "credential-ref-1",
  receive_id_type: "open_id" as const,
  receive_id: "ou-human-1",
  msg_type: "text" as const,
  content: JSON.stringify({ text: "hello" }),
  uuid: "wf_123",
};

describe("FeishuOpenApiClient", () => {
  it("refreshes once after token rejection and preserves UUID", async () => {
    const bodies: unknown[] = [];
    let call = 0;
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      call += 1;
      return new Response(JSON.stringify(call === 1
        ? { code: 99991663, msg: "token expired" }
        : { code: 0, data: { message_id: "om-1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    const tokens = new Tokens();
    const client = new FeishuOpenApiClient({
      token_provider: tokens,
      fetch,
      base_url: "https://open.feishu.test",
      request_timeout_ms: 1_000,
      max_response_bytes: 64_000,
    });

    await expect(client.sendMessage(message)).resolves.toEqual({
      kind: "accepted",
      message_id: "om-1",
    });
    expect(tokens.calls).toEqual([false, true]);
    expect(bodies).toEqual([
      expect.objectContaining({ uuid: "wf_123" }),
      expect.objectContaining({ uuid: "wf_123" }),
    ]);
  });

  it.each([
    [429, "retryable_failure"],
    [503, "retryable_failure"],
    [400, "permanent_failure"],
    [403, "permanent_failure"],
  ] as const)("classifies HTTP %s as %s", async (status, kind) => {
    const client = new FeishuOpenApiClient({
      token_provider: new Tokens(),
      fetch: vi.fn(async () => new Response(JSON.stringify({ code: 1 }), {
        status,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch,
      base_url: "https://open.feishu.test",
      request_timeout_ms: 1_000,
      max_response_bytes: 64_000,
    });
    await expect(client.sendMessage(message)).resolves.toMatchObject({ kind });
  });
});
