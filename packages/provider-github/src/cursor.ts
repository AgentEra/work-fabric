import { createHmac, timingSafeEqual } from "node:crypto";

import { GitHubProviderError } from "./errors.js";

export interface GitHubCursorState {
  readonly version: 1;
  readonly scope_hash: `sha256:${string}`;
  readonly page: number;
}

export interface GitHubCursorCodec {
  encode(state: GitHubCursorState): string;
  decode(cursor: string, scopeHash: `sha256:${string}`): GitHubCursorState;
}

export interface HmacGitHubCursorCodecOptions {
  readonly key: Uint8Array;
}

const CURSOR = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

function invalid(): never {
  throw new GitHubProviderError("github_invalid_request");
}

function scopeHash(value: unknown): `sha256:${string}` {
  if (
    typeof value !== "string" ||
    !value.startsWith("sha256:") ||
    value.length <= "sha256:".length ||
    value.length > 256 ||
    value.trim() !== value
  ) invalid();
  return value as `sha256:${string}`;
}

function page(value: unknown): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) ||
    value < 1 || value > 10_000
  ) invalid();
  return value;
}

function normalize(value: unknown): GitHubCursorState {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) invalid();
  const source = value as Record<string, unknown>;
  const fields = ["version", "scope_hash", "page"];
  if (
    Object.keys(source).length !== fields.length ||
    Object.keys(source).some((field) => !fields.includes(field)) ||
    source.version !== 1
  ) invalid();
  return Object.freeze({ version: 1, scope_hash: scopeHash(source.scope_hash), page: page(source.page) });
}

function canonical(state: GitHubCursorState): string {
  return JSON.stringify({
    version: state.version,
    scope_hash: state.scope_hash,
    page: state.page,
  });
}

export class HmacGitHubCursorCodec implements GitHubCursorCodec {
  private readonly key: Uint8Array;

  constructor(options: HmacGitHubCursorCodecOptions) {
    if (
      options === null || typeof options !== "object" ||
      !(options.key instanceof Uint8Array) || options.key.byteLength < 32
    ) invalid();
    this.key = new Uint8Array(options.key);
  }

  encode(value: GitHubCursorState): string {
    const state = normalize(value);
    const payload = Buffer.from(canonical(state), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.key).update(payload).digest("base64url");
    const cursor = `${payload}.${signature}`;
    if (cursor.length > 4_096) invalid();
    return cursor;
  }

  decode(cursor: string, expectedScopeHash: `sha256:${string}`): GitHubCursorState {
    try {
      if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 4_096) invalid();
      const match = CURSOR.exec(cursor);
      if (match === null) invalid();
      const payload = match[1]!;
      const expected = createHmac("sha256", this.key).update(payload).digest();
      const supplied = Buffer.from(match[2]!, "base64url");
      if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) invalid();
      const state = normalize(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
      if (state.scope_hash !== scopeHash(expectedScopeHash)) invalid();
      return state;
    } catch (error) {
      if (error instanceof GitHubProviderError) throw error;
      invalid();
    }
  }
}
