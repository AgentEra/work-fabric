export class FeishuBoundedResponseError extends Error {
  constructor() {
    super("Feishu response exceeds its configured byte limit");
  }
}

export async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maximumBytes) {
    throw new FeishuBoundedResponseError();
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new FeishuBoundedResponseError();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}
