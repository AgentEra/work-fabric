import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("conformance CLI", () => {
  it("runs all repository cases and prints a deterministic summary", async () => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "tools/conformance/src/cli.ts",
      ],
      { cwd: process.cwd() },
    );

    expect(stderr).toBe("");
    expect(stdout).toMatch(/^WFPP v1 conformance: \d+\/\d+ passed\n$/);
    const [, passed, total] = stdout.match(/(\d+)\/(\d+)/) ?? [];
    expect(Number(passed)).toBeGreaterThan(60);
    expect(passed).toBe(total);
  });
});
