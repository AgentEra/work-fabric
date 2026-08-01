import { describe, expect, it, vi } from "vitest";

import {
  FeishuSharedFolderPolicyError,
  FeishuSharedFolderPolicyVerifier,
} from "../src/index.js";

function response(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    ...(headers === undefined ? {} : { headers }),
  });
}

function verifier(fetch: typeof globalThis.fetch) {
  return new FeishuSharedFolderPolicyVerifier({
    credential_ref: "feishu-primary",
    token_provider: {
      async getToken(_credentialRef: string, forceRefresh = false) {
        return forceRefresh ? "tenant-token-refreshed" : "tenant-token";
      },
    },
    fetch,
    base_url: "https://open.feishu.test",
    request_timeout_ms: 5_000,
    max_response_bytes: 64_000,
    folder_token: "fld-shared-team",
    policy_ref: "feishu.shared-folder.default",
    visibility: "tenant_readable",
  });
}

describe("FeishuSharedFolderPolicyVerifier", () => {
  it("requires an editable folder and tenant-readable public policy", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/drive/v1/files?")) {
        return response({
          code: 0,
          data: { files: [], has_more: false },
        });
      }
      if (url.includes("/permissions/fld-shared-team/public")) {
        return response({
          code: 0,
          data: {
            permission_public: {
              link_share_entity: "tenant_readable",
            },
          },
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    await expect(verifier(fetch).verify(
      new AbortController().signal,
    )).resolves.toEqual({
      policy_ref: "feishu.shared-folder.default",
      status: "ready",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[0]?.[0])).toContain(
      "folder_token=fld-shared-team",
    );
  });

  it.each([
    [
      "inaccessible",
      async () => response({ code: 1061003, msg: "not found" }, 404),
      "shared_folder_inaccessible",
    ],
    [
      "not editable",
      async () => response({ code: 1061004, msg: "forbidden" }, 403),
      "shared_folder_not_editable",
    ],
    [
      "malformed",
      async () => response({ code: 0, data: { files: "not-an-array" } }),
      "shared_folder_response_invalid",
    ],
    [
      "oversized",
      async () => response(
        { code: 0, data: { files: [] } },
        200,
        { "content-length": "999999" },
      ),
      "shared_folder_response_invalid",
    ],
  ])("fails closed for an %s folder probe", async (_name, fetch, code) => {
    await expect(verifier(vi.fn(fetch)).verify(
      new AbortController().signal,
    )).rejects.toEqual(expect.objectContaining<
      Partial<FeishuSharedFolderPolicyError>
    >({ code: code as FeishuSharedFolderPolicyError["code"] }));
  });

  it("rejects non-tenant-readable and ambiguous permission responses", async () => {
    const base = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/drive/v1/files?")) {
        return response({ code: 0, data: { files: [], has_more: false } });
      }
      return response({
        code: 0,
        data: {
          permission_public: { link_share_entity: "closed" },
        },
      });
    };
    await expect(verifier(vi.fn(base)).verify(
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: "shared_folder_visibility_invalid",
    });

    const ambiguous = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/drive/v1/files?")) {
        return response({ code: 0, data: { files: [], has_more: false } });
      }
      return response({
        code: 0,
        data: { permission_public: {} },
      });
    };
    await expect(verifier(vi.fn(ambiguous)).verify(
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: "shared_folder_response_invalid",
    });
  });

  it("refreshes once on 401 and fails without exposing vendor bodies", async () => {
    const fetch = vi.fn(async () =>
      response({ code: 99991663, msg: "sensitive vendor body" }, 401)
    );
    const error = await verifier(fetch).verify(
      new AbortController().signal,
    ).catch((cause: unknown) => cause);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(error).toMatchObject({
      code: "shared_folder_authentication_failed",
    });
    expect(String(error)).not.toContain("sensitive vendor body");
  });
});
