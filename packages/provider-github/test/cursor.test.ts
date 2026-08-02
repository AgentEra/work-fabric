import { describe, expect, it } from "vitest";

import { HmacGitHubCursorCodec } from "../src/index.js";

describe("HmacGitHubCursorCodec", () => {
  it("round-trips a deterministic signed cursor", () => {
    const codec = new HmacGitHubCursorCodec({ key: Buffer.alloc(32, 7) });
    const state = { version: 1 as const, scope_hash: "sha256:a" as const, page: 2 };
    const cursor = codec.encode(state);

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(cursor).toBe(codec.encode(state));
    expect(codec.decode(cursor, "sha256:a")).toEqual(state);
  });

  it("rejects a cursor copied to a different query", () => {
    const codec = new HmacGitHubCursorCodec({ key: Buffer.alloc(32, 7) });
    const cursor = codec.encode({ version: 1, scope_hash: "sha256:a", page: 2 });

    expect(() => codec.decode(cursor, "sha256:b")).toThrowError(
      "github_invalid_request",
    );
  });

  it("rejects tampering and pages outside the supported range", () => {
    const codec = new HmacGitHubCursorCodec({ key: Buffer.alloc(32, 7) });
    const cursor = codec.encode({ version: 1, scope_hash: "sha256:a", page: 2 });

    expect(() => codec.decode(`${cursor}x`, "sha256:a"))
      .toThrowError("github_invalid_request");
    expect(() => codec.encode({ version: 1, scope_hash: "sha256:a", page: 0 }))
      .toThrowError("github_invalid_request");
    expect(() => codec.encode({ version: 1, scope_hash: "sha256:a", page: 10_001 }))
      .toThrowError("github_invalid_request");
  });
});
