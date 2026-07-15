import { describe, expect, it } from "vitest";

import { SseDeliveryParser, WorkFabricTransportError } from "../src/index.js";

const delivery = (cursor = "cursor_01", events: readonly unknown[] = [{ id: "event_01" }]) => ({
  delivery_id: "delivery_01",
  subscription_id: "subscription_01",
  attempt: 1,
  events,
  next_cursor: cursor,
  delivered_at: "2026-07-15T10:00:00.000Z",
  visibility_expires_at: "2026-07-15T10:01:00.000Z",
});

function frame(data = delivery(), newline = "\n") {
  return [
    "id: cursor_01",
    "event: workfabric.delivery",
    `data: ${JSON.stringify(data)}`,
    "",
    "",
  ].join(newline);
}

describe("SseDeliveryParser", () => {
  it("parses split UTF-8, BOM, CRLF, comments, heartbeats, and multiple frames", () => {
    const parser = new SseDeliveryParser(16_384);
    const bytes = new TextEncoder().encode(`\uFEFF: connected\r\n\r\n${frame()}${frame()}`);
    const frames = [];
    for (let index = 0; index < bytes.length; index += 3) {
      frames.push(...parser.push(bytes.slice(index, index + 3)));
    }
    frames.push(...parser.finish());

    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({
      id: "cursor_01",
      event: "workfabric.delivery",
      data: { delivery_id: "delivery_01", next_cursor: "cursor_01" },
    });
  });

  it("joins multiple data lines and flushes a final frame at EOF", () => {
    const parser = new SseDeliveryParser(16_384);
    const value = JSON.stringify(delivery()).slice(1);
    const input = `id: cursor_01\nevent: workfabric.delivery\ndata: {\ndata:${value}`;
    const frames = [...parser.push(new TextEncoder().encode(input)), ...parser.finish()];
    expect(frames).toHaveLength(1);
    expect(frames[0]?.data.delivery_id).toBe("delivery_01");
  });

  it.each([
    ["event: other\nid: cursor_01\ndata: {}\n\n", "event type"],
    [`event: workfabric.delivery\nid: other\ndata: ${JSON.stringify(delivery())}\n\n`, "cursor"],
    [`event: workfabric.delivery\nid: cursor_01\ndata: ${JSON.stringify(delivery("cursor_01", []))}\n\n`, "one Event"],
    [`event: workfabric.delivery\nid: cursor_01\ndata: ${JSON.stringify(delivery("cursor_01", [{ id: "one" }, { id: "two" }]))}\n\n`, "one Event"],
    ["event: workfabric.delivery\nid: cursor_01\ndata: {\n\n", "JSON"],
  ])("rejects malformed delivery frames (%s)", (input) => {
    const parser = new SseDeliveryParser(16_384);
    expect(() => parser.push(new TextEncoder().encode(input))).toThrow(WorkFabricTransportError);
  });

  it("bounds incomplete and complete frame memory", () => {
    const parser = new SseDeliveryParser(32);
    expect(() => parser.push(new TextEncoder().encode("data: " + "x".repeat(40)))).toThrowError(
      expect.objectContaining({ code: "stream_protocol_error" }),
    );
  });
});
