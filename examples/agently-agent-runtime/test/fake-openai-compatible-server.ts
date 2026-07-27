import { createServer, type IncomingMessage, type Server } from "node:http";

export interface FakeOpenAiCompatibleServer {
  readonly baseUrl: string;
  readonly requests: readonly { readonly handoffId: string | null; readonly path: string }[];
  /** Number of model responses abandoned before this local fake could finish. */
  readonly abortedResponses: number;
  requestCountFor(handoffId: string): number;
  close(): Promise<void>;
}

export interface FakeOpenAiCompatibleServerOptions {
  readonly structuredOutput: Record<string, unknown>;
  readonly structuredOutputs?: readonly Record<string, unknown>[];
  readonly delayMs?: number;
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function handoffId(value: string): string | null {
  try {
    const pending: unknown[] = [JSON.parse(value)];
    while (pending.length > 0) {
      const current = pending.pop();
      if (typeof current === "string") {
        const match = /"handoff_id"\s*:\s*"([^"\\]{1,128})"/.exec(current);
        if (match !== null) return match[1] ?? null;
      } else if (Array.isArray(current)) pending.push(...current);
      else if (current !== null && typeof current === "object") {
        const fields = current as Record<string, unknown>;
        // Agently can preserve task input as a structured value instead of a
        // JSON-encoded string. Retain only the bounded identifier used by the
        // test; request bodies and credentials are never retained.
        if (typeof fields.handoff_id === "string" && /^[^"\\]{1,128}$/.test(fields.handoff_id)) {
          return fields.handoff_id;
        }
        pending.push(...Object.values(fields));
      }
    }
  } catch { /* only used for bounded test observability */ }
  return null;
}

/** A deliberately narrow, local Chat Completions endpoint for worker E2E tests. */
export async function startFakeOpenAiCompatibleServer(
  options: FakeOpenAiCompatibleServerOptions,
): Promise<FakeOpenAiCompatibleServer> {
  const requests: Array<{ handoffId: string | null; path: string }> = [];
  let abortedResponses = 0;
  const server = createServer(async (request, response) => {
    const payload = await body(request);
    if (request.method === "POST") {
      requests.push({ handoffId: handoffId(payload), path: request.url ?? "" });
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    response.once("close", () => {
      if (!response.writableEnded) abortedResponses += 1;
    });
    if (options.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    const output = options.structuredOutputs?.[
      Math.min(requests.length - 1, options.structuredOutputs.length - 1)
    ] ?? options.structuredOutput;
    const event = JSON.stringify({
      id: "chatcmpl-work-fabric-test",
      object: "chat.completion",
      created: 0,
      model: "fake-work-fabric-model",
      choices: [{
        index: 0,
        delta: { role: "assistant", content: JSON.stringify(output) },
        finish_reason: null,
      }],
    });
    const finished = JSON.stringify({
      id: "chatcmpl-work-fabric-test", object: "chat.completion", created: 0, model: "fake-work-fabric-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${event}\n\ndata: ${finished}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake model did not bind a TCP port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    get requests() { return Object.freeze(requests.map((request) => ({ ...request }))); },
    get abortedResponses() { return abortedResponses; },
    requestCountFor(id) { return requests.filter((request) => request.handoffId === id).length; },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))),
  };
}
