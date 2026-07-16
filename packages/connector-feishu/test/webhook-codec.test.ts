import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  FeishuWebhookError,
  verifyFeishuWebhook,
  type FeishuWebhookCredentials,
} from "../src/index.js";

const credentials: FeishuWebhookCredentials = {
  verification_token: "verification-value",
  encrypt_key: "encrypt-value",
};

function sign(raw: Uint8Array, timestamp: string, nonce: string): string {
  return createHash("sha256")
    .update(timestamp)
    .update(nonce)
    .update(credentials.encrypt_key!)
    .update(raw)
    .digest("hex");
}

// Frozen against the current official larksuite/node-sdk AESCipher contract:
// SHA-256 key, ciphertext-prefixed IV, AES-256-CBC, PKCS padding.
const ENCRYPTED_EVENT_FIXTURE =
  "MDEyMzQ1Njc4OWFiY2RlZsLgmT+tkGAZWWqVcmKpB7mjESQH8ufx7ZOengDHDowdOKmT+P7H44cOr+nU1fjMMir7yO4jtvxfdAZDUv7r8S0sId2IITOYXV2nIu/IF/FQu+jsGGokO0HhAGAE+6CvSHj/2+m9JJwkURRxvwp0kvDLBEWIIkQ5IvKM03ZQCAv3WjvLQQKz6kXPUTRu4pKIxpOZAWJdBPC2SqNagEaHOV1lVFKT+F/1U3XIeLXVU4uVpr/A0ZWaTDawvkKzAnCs8Q==";

describe("Feishu webhook codec", () => {
  it("verifies, decrypts, and removes verification material", async () => {
    const raw = Buffer.from(JSON.stringify({
      encrypt: ENCRYPTED_EVENT_FIXTURE,
    }));
    const timestamp = "1784073600";
    const nonce = "nonce-1";
    const result = await verifyFeishuWebhook({
      raw_body: raw,
      timestamp,
      nonce,
      signature: sign(raw, timestamp, nonce),
      now_epoch_seconds: 1784073600,
      credentials,
      limits: { max_body_bytes: 64_000, max_clock_skew_seconds: 300, max_json_depth: 16 },
    });

    expect(result.kind).toBe("event");
    if (result.kind !== "event") return;
    expect(result.body.header).not.toHaveProperty("token");
    expect(result.body.event).toEqual({ message: { message_id: "om-1" } });
  });

  it("returns URL verification challenges without producing an event", async () => {
    const raw = Buffer.from(JSON.stringify({
      type: "url_verification",
      challenge: "challenge-1",
      token: "verification-value",
    }));
    const result = await verifyFeishuWebhook({
      raw_body: raw,
      now_epoch_seconds: 1784073600,
      credentials: { verification_token: "verification-value" },
      limits: { max_body_bytes: 64_000, max_clock_skew_seconds: 300, max_json_depth: 16 },
    });
    expect(result).toEqual({ kind: "challenge", challenge: "challenge-1" });
  });

  it.each<readonly [string, { signature?: string; timestamp?: string }]>([
    ["signature", { signature: "0".repeat(64) }],
    ["timestamp", { timestamp: "1784073000" }],
  ])("rejects an invalid %s without exposing callback content", async (_label, change) => {
    const raw = Buffer.from(JSON.stringify({
      token: credentials.verification_token,
      event: { content: "do-not-leak" },
    }));
    const timestamp = "1784073600";
    const nonce = "nonce-1";
    await expect(verifyFeishuWebhook({
      raw_body: raw,
      timestamp: change.timestamp ?? timestamp,
      nonce,
      signature: change.signature ?? sign(raw, timestamp, nonce),
      now_epoch_seconds: 1784073600,
      credentials,
      limits: { max_body_bytes: 64_000, max_clock_skew_seconds: 300, max_json_depth: 16 },
    })).rejects.toSatisfy((error: unknown) =>
      error instanceof FeishuWebhookError &&
      !error.message.includes("do-not-leak"));
  });

  it("rejects oversized and over-nested bodies before mapping", async () => {
    await expect(verifyFeishuWebhook({
      raw_body: Buffer.from("x".repeat(101)),
      now_epoch_seconds: 1784073600,
      credentials: { verification_token: "verification-value" },
      limits: { max_body_bytes: 100, max_clock_skew_seconds: 300, max_json_depth: 3 },
    })).rejects.toMatchObject({ code: "body_too_large" });

    const raw = Buffer.from(JSON.stringify({
      token: "verification-value",
      value: { one: { two: { three: true } } },
    }));
    await expect(verifyFeishuWebhook({
      raw_body: raw,
      now_epoch_seconds: 1784073600,
      credentials: { verification_token: "verification-value" },
      limits: { max_body_bytes: 1_000, max_clock_skew_seconds: 300, max_json_depth: 3 },
    })).rejects.toMatchObject({ code: "json_too_deep" });
  });
});
