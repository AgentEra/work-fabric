import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import { sendDebugMessage } from "./local-debug-send.js";

describe("local Debug Channel sender", () => {
  it("submits a JSON fixture and polls correlation without printing its token", async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? "");
      response.setHeader("content-type", "application/json");
      if (request.method === "POST") {
        request.resume();
        response.end(JSON.stringify({
          submission_id: "submission-1",
          ingress_id: "ingress-1",
          ingress_state: "pending",
        }));
      } else {
        response.end(JSON.stringify({
          submission_id: "submission-1",
          ingress: { ingress_id: "ingress-1", state: "completed" },
          handoff: { handoff_id: "handoff-1", lifecycle_state: "closed" },
        }));
      }
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error();
    try {
      const result = await sendDebugMessage({
        base_url: `http://127.0.0.1:${address.port}`,
        token: "must-not-be-returned",
        conversation_id: "conversation-1",
        message: {
          idempotency_key: "message-1",
          participant_ref: "internal-user",
          content: [{
            kind: "text",
            media_type: "text/plain",
            text: "hello",
          }],
        },
        wait_ms: 500,
      });
      expect(result).toMatchObject({
        submission_id: "submission-1",
        handoff: { handoff_id: "handoff-1" },
      });
      expect(JSON.stringify(result)).not.toContain("must-not-be-returned");
      expect(requests).toEqual([
        "/v1/conversations/conversation-1/messages",
        "/v1/submissions/submission-1",
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
