import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  FeishuLongConnectionAcceptance,
  FeishuLongConnectionClient,
  FeishuLongConnectionClientFactory,
  FeishuLongConnectionHandler,
  FeishuLongConnectionStatus,
} from "@work-fabric/connector-feishu";
import type { JsonObject } from "@work-fabric/exchange-spi";

/**
 * Owns the temporary root for neutral E2E fixtures.  Individual fixture
 * builders register close operations as they start resources, so a failure in
 * any later startup step cannot leak an earlier service, Runtime Host, model
 * server, or workspace.
 */
export class NeutralE2eFixture {
  private readonly closers: Array<() => Promise<void>> = [];

  private constructor(readonly directory: string) {}

  static async create(prefix: string): Promise<NeutralE2eFixture> {
    return new NeutralE2eFixture(await mkdtemp(join(tmpdir(), prefix)));
  }

  register(close: () => Promise<void>): void {
    this.closers.unshift(close);
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.closers.map((close) => close()));
    await rm(this.directory, { recursive: true, force: true });
  }
}

export async function eventually(
  assertion: () => Promise<void>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw last;
}

/**
 * The channel adapter owns the real long-connection client in production.
 * Tests use this neutral source to drive the same handler without a Feishu
 * network connection or an HTTP webhook back door.
 */
export class FakeFeishuLongConnectionClient implements FeishuLongConnectionClient {
  handler: FeishuLongConnectionHandler | undefined;
  snapshot: FeishuLongConnectionStatus = {
    state: "connecting",
    code: "connecting",
    reconnect_attempts: 0,
    changed_at: "2026-07-17T00:00:00.000Z",
  };

  start(handler: FeishuLongConnectionHandler): Promise<void> {
    this.handler = handler;
    return Promise.resolve();
  }

  status(): FeishuLongConnectionStatus {
    return { ...this.snapshot };
  }

  stop(): Promise<void> {
    this.snapshot = { ...this.snapshot, state: "stopped", code: "stopped" };
    return Promise.resolve();
  }

  emit(body: JsonObject): Promise<FeishuLongConnectionAcceptance> {
    if (this.handler === undefined) throw new Error("fake_not_started");
    return this.handler(body);
  }
}

export class FakeFeishuLongConnectionClientFactory
implements FeishuLongConnectionClientFactory {
  readonly clients: FakeFeishuLongConnectionClient[] = [];

  create(): FeishuLongConnectionClient {
    const client = new FakeFeishuLongConnectionClient();
    this.clients.push(client);
    return client;
  }
}
