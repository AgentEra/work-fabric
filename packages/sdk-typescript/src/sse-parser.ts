import { WorkFabricTransportError } from "./errors.js";
import type { EventDelivery, SseDeliveryFrame } from "./protocol-types.js";

function protocolError(): never {
  throw new WorkFabricTransportError(
    "stream_protocol_error",
    "The Work Fabric event stream returned an invalid frame",
  );
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return protocolError();
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, maximum = 2048): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    return protocolError();
  }
  return value;
}

export function decodeEventDelivery(
  value: unknown,
  exactlyOneEvent = false,
): EventDelivery {
  const candidate = record(value);
  const events = candidate.events;
  if (
    !Number.isSafeInteger(candidate.attempt) ||
    (candidate.attempt as number) < 1 ||
    !Array.isArray(events) ||
    events.length === 0 ||
    (exactlyOneEvent && events.length !== 1) ||
    events.some((event) => {
      if (typeof event !== "object" || event === null || Array.isArray(event)) return true;
      const candidate = event as Record<string, unknown>;
      return candidate.specversion !== "1.0" ||
        typeof candidate.id !== "string" || candidate.id.length === 0 ||
        typeof candidate.type !== "string" || candidate.type.length === 0 ||
        typeof candidate.subject !== "string" || candidate.subject.length === 0 ||
        typeof candidate.time !== "string" || candidate.time.length === 0;
    })
  ) {
    return protocolError();
  }
  requiredString(candidate.delivery_id, 128);
  requiredString(candidate.subscription_id, 128);
  requiredString(candidate.next_cursor);
  requiredString(candidate.delivered_at, 64);
  requiredString(candidate.visibility_expires_at, 64);
  return candidate as unknown as EventDelivery;
}

export class SseDeliveryParser {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly encoder = new TextEncoder();
  private text = "";
  private readonly lines: string[] = [];
  private firstLine = true;
  private finished = false;

  constructor(private readonly maxFrameBytes: number) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
      throw new TypeError("maxFrameBytes must be a positive safe integer");
    }
  }

  push(chunk: Uint8Array): readonly SseDeliveryFrame[] {
    if (this.finished) throw new TypeError("SSE parser is already finished");
    try {
      this.text += this.decoder.decode(chunk, { stream: true });
    } catch {
      return protocolError();
    }
    return this.drain(false);
  }

  finish(): readonly SseDeliveryFrame[] {
    if (this.finished) return [];
    this.finished = true;
    try {
      this.text += this.decoder.decode();
    } catch {
      return protocolError();
    }
    return this.drain(true);
  }

  private drain(atEof: boolean): readonly SseDeliveryFrame[] {
    const frames: SseDeliveryFrame[] = [];
    let newline = this.text.indexOf("\n");
    while (newline >= 0) {
      let line = this.text.slice(0, newline);
      this.text = this.text.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      const frame = this.consumeLine(line);
      if (frame !== null) frames.push(frame);
      newline = this.text.indexOf("\n");
    }
    if (atEof && this.text.length > 0) {
      let line = this.text;
      this.text = "";
      if (line.endsWith("\r")) line = line.slice(0, -1);
      const frame = this.consumeLine(line);
      if (frame !== null) frames.push(frame);
    }
    this.assertBounded();
    if (atEof && this.lines.length > 0) {
      const frame = this.dispatch();
      if (frame !== null) frames.push(frame);
    }
    return frames;
  }

  private consumeLine(input: string): SseDeliveryFrame | null {
    const line = this.firstLine ? input.replace(/^\uFEFF/, "") : input;
    this.firstLine = false;
    if (line === "") return this.dispatch();
    this.lines.push(line);
    this.assertBounded();
    return null;
  }

  private assertBounded(): void {
    const bytes = this.encoder.encode(
      `${this.lines.join("\n")}${this.lines.length > 0 && this.text.length > 0 ? "\n" : ""}${this.text}`,
    ).byteLength;
    if (bytes > this.maxFrameBytes) protocolError();
  }

  private dispatch(): SseDeliveryFrame | null {
    const lines = this.lines.splice(0);
    let id: string | undefined;
    let event: string | undefined;
    const data: string[] = [];
    for (const line of lines) {
      if (line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator < 0 ? line : line.slice(0, separator);
      let value = separator < 0 ? "" : line.slice(separator + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "id") id = value;
      if (field === "event") event = value;
      if (field === "data") data.push(value);
    }
    if (data.length === 0) return null;
    if (event !== "workfabric.delivery" || id === undefined) protocolError();
    requiredString(id);
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.join("\n")) as unknown;
    } catch {
      return protocolError();
    }
    const delivery = decodeEventDelivery(parsed, true);
    if (delivery.next_cursor !== id) protocolError();
    return { id, event: "workfabric.delivery", data: delivery };
  }
}
