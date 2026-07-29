import { describe, expect, it } from "vitest";
import {
  debugMessageDigest,
  normalizeDebugMessage,
} from "../src/index.js";
import { validDebugConfig } from "./fixtures.js";

const limits = validDebugConfig().limits;

describe("Debug Channel content", () => {
  it("preserves ordered text, data and resource parts", () => {
    const message = normalizeDebugMessage({
      idempotency_key: "mixed-1",
      participant_ref: "internal-user",
      content: [
        {
          kind: "text",
          media_type: "text/markdown",
          text: "请总结 **EDA**",
          language: "zh-CN",
        },
        {
          kind: "data",
          schema_ref: "https://schemas.example.test/eda/v1",
          data: { status: "draft", topics: ["event", "consumer"] },
        },
        {
          kind: "resource",
          resource: {
            uri: "https://example.com/eda",
            name: "EDA 资料",
            media_type: "text/html",
            access_hint: "public",
            extensions: {},
          },
        },
      ],
    }, limits);
    expect(message.content.map((part) => part.kind)).toEqual([
      "text",
      "data",
      "resource",
    ]);
    expect(message.content).toEqual([
      {
        kind: "text",
        media_type: "text/markdown",
        text: "请总结 **EDA**",
        language: "zh-CN",
      },
      {
        kind: "data",
        schema_ref: "https://schemas.example.test/eda/v1",
        data: { status: "draft", topics: ["event", "consumer"] },
      },
      {
        kind: "resource",
        resource: {
          uri: "https://example.com/eda",
          name: "EDA 资料",
          media_type: "text/html",
          access_hint: "public",
          extensions: {},
        },
      },
    ]);
  });

  it("produces the same digest for different JSON object key order", () => {
    const left = normalizeDebugMessage({
      idempotency_key: "data-1",
      participant_ref: "internal-user",
      content: [{
        kind: "data",
        schema_ref: "https://schemas.example.test/v1",
        data: { b: 2, a: 1 },
      }],
    }, limits);
    const right = normalizeDebugMessage({
      participant_ref: "internal-user",
      content: [{
        data: { a: 1, b: 2 },
        schema_ref: "https://schemas.example.test/v1",
        kind: "data",
      }],
      idempotency_key: "data-1",
    }, limits);
    expect(debugMessageDigest(left)).toBe(debugMessageDigest(right));
    expect(debugMessageDigest(left)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects protocol-invalid text media types", () => {
    expect(() => normalizeDebugMessage({
      idempotency_key: "bad-media",
      participant_ref: "internal-user",
      content: [{ kind: "text", media_type: "application/json", text: "{}" }],
    }, limits)).toThrow("media_type");
  });

  it("rejects an unknown content field", () => {
    expect(() => normalizeDebugMessage({
      idempotency_key: "unknown-field",
      participant_ref: "internal-user",
      content: [{
        kind: "text",
        media_type: "text/plain",
        text: "hello",
        html: "<b>hello</b>",
      }],
    }, limits)).toThrow("content[0]");
  });

  it("enforces aggregate UTF-8 text bytes", () => {
    expect(() => normalizeDebugMessage({
      idempotency_key: "large",
      participant_ref: "internal-user",
      content: [
        { kind: "text", media_type: "text/plain", text: "你".repeat(50_000) },
      ],
    }, { ...limits, max_text_bytes: 100_000 })).toThrow("max_text_bytes");
  });

  it("rejects JSON deeper than the configured bound", () => {
    expect(() => normalizeDebugMessage({
      idempotency_key: "deep",
      participant_ref: "internal-user",
      content: [{
        kind: "data",
        schema_ref: "https://schemas.example.test/v1",
        data: { a: { b: { c: true } } },
      }],
    }, { ...limits, max_json_depth: 2 })).toThrow("max_json_depth");
  });
});
