import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  NATS_SERVER_VERSION,
  natsServerAsset,
  runOfficialNatsServerCommand,
  verifyReleaseChecksum,
  type NatsServerReleaseDependencies,
} from "./nats-server-release.js";

describe("official NATS Server release runner", () => {
  it("selects only supported official release assets", () => {
    expect(natsServerAsset("darwin", "arm64")).toMatchObject({
      filename: `nats-server-v${NATS_SERVER_VERSION}-darwin-arm64.tar.gz`,
      archive: "tar.gz",
    });
    expect(natsServerAsset("linux", "x64")).toMatchObject({
      filename: `nats-server-v${NATS_SERVER_VERSION}-linux-amd64.tar.gz`,
      archive: "tar.gz",
    });
    expect(natsServerAsset("linux", "arm64")).toMatchObject({
      filename: `nats-server-v${NATS_SERVER_VERSION}-linux-arm64.tar.gz`,
      archive: "tar.gz",
    });
    expect(() => natsServerAsset("win32", "x64")).toThrow(/unsupported/);
  });

  it("rejects a release archive that does not match SHA256SUMS", () => {
    const bytes = new TextEncoder().encode("official archive");
    const filename = `nats-server-v${NATS_SERVER_VERSION}-linux-amd64.tar.gz`;
    const checksum = createHash("sha256").update(bytes).digest("hex");
    expect(() => verifyReleaseChecksum(bytes, `${checksum}  ${filename}\n`, filename))
      .not.toThrow();
    expect(() => verifyReleaseChecksum(
      new TextEncoder().encode("tampered"),
      `${checksum}  ${filename}\n`,
      filename,
    )).toThrow(/checksum/);
  });

  it("always stops the server and removes the temporary directory", async () => {
    const events: string[] = [];
    const archive = new TextEncoder().encode("archive");
    const asset = natsServerAsset("linux", "x64");
    const checksum = createHash("sha256").update(archive).digest("hex");
    const dependencies: NatsServerReleaseDependencies = {
      platform: "linux",
      architecture: "x64",
      makeTempDirectory: async () => {
        events.push("temp");
        return "/tmp/fake-nats-release";
      },
      download: async (url) => {
        events.push(url.endsWith("SHA256SUMS") ? "sums" : "archive");
        return url.endsWith("SHA256SUMS")
          ? new TextEncoder().encode(`${checksum}  ${asset.filename}\n`)
          : archive;
      },
      writeArchive: async () => { events.push("write"); },
      extract: async () => { events.push("extract"); },
      startServer: async () => {
        events.push("start");
        return {
          url: "nats://127.0.0.1:4222",
          stop: async () => { events.push("stop"); },
        };
      },
      runCommand: async (_command, environment) => {
        events.push(`command:${environment.NATS_TEST_URL}`);
        throw new Error("command failed");
      },
      removeTempDirectory: async () => { events.push("remove"); },
    };

    await expect(runOfficialNatsServerCommand(["npm", "test"], dependencies))
      .rejects.toThrow(/command failed/);
    expect(events).toEqual([
      "temp",
      "sums",
      "archive",
      "write",
      "extract",
      "start",
      "command:nats://127.0.0.1:4222",
      "stop",
      "remove",
    ]);
  });
});
