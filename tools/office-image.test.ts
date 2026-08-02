import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { requiredProcessesPresent } from "../deploy/office/healthcheck.js";

describe("office deployment image", () => {
  it("pins its runtimes and excludes local state and credentials", async () => {
    const [dockerfile, dockerignore] = await Promise.all([
      readFile("deploy/office/Dockerfile", "utf8"),
      readFile(".dockerignore", "utf8"),
    ]);

    expect(dockerfile).toContain("node:22.20.0-bookworm-slim");
    expect(dockerfile).toContain("python:3.12.11-slim-bookworm");
    expect(dockerfile).toContain("uv==0.8.22");
    expect(dockerfile).toContain(
      "uv sync --project runtimes/agently-worker --frozen --no-dev",
    );
    expect(dockerfile).toContain("HEALTHCHECK");
    expect(dockerfile).not.toMatch(/\blatest\b/);
    expect(dockerignore).toContain("feishu.env");
    expect(dockerignore).toContain("var/");
    expect(dockerignore).toContain("node_modules/");
    expect(dockerignore).toContain(".git");
  });

  it("bounds package fetch concurrency and retries transient registry resets", async () => {
    const dockerfile = await readFile("deploy/office/Dockerfile", "utf8");

    expect(dockerfile).toContain("--fetch-retries=5");
    expect(dockerfile).toContain("--fetch-retry-mintimeout=2000");
    expect(dockerfile).toContain("--fetch-retry-maxtimeout=30000");
    expect(dockerfile).toContain("--maxsockets=1");
  });

  it("reports the composed office stack unhealthy when a required participant dies", async () => {
    const [dockerfile, healthcheck] = await Promise.all([
      readFile("deploy/office/Dockerfile", "utf8"),
      readFile("deploy/office/healthcheck.ts", "utf8"),
    ]);

    expect(dockerfile).toContain("deploy/office/healthcheck.ts");
    expect(healthcheck).toContain("packages/service-node/src/main.ts");
    expect(healthcheck).toContain(
      "examples/agently-agent-runtime/src/main.ts",
    );
    expect(healthcheck).toContain(
      "examples/feishu-capability-provider/src/main.ts",
    );
    expect(requiredProcessesPresent([
      "node packages/service-node/src/main.ts",
      "node examples/feishu-capability-provider/src/main.ts",
    ])).toBe(false);
    expect(requiredProcessesPresent([
      "node packages/service-node/src/main.ts",
      "node examples/feishu-capability-provider/src/main.ts",
      "node examples/agently-agent-runtime/src/main.ts",
    ])).toBe(true);
    expect(requiredProcessesPresent([
      "observer packages/service-node/src/main.ts "
        + "examples/feishu-capability-provider/src/main.ts "
        + "examples/agently-agent-runtime/src/main.ts",
    ])).toBe(false);
  });
});
