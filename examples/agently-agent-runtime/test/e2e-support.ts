import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
