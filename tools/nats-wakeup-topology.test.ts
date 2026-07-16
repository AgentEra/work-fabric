import { describe, expect, it } from "vitest";

import {
  runNatsWakeupTopology,
  type NatsWakeupTopologyCliExecution,
} from "./nats-wakeup-topology.js";

const config = JSON.stringify({
  stream: "WF_WAKEUP",
  consumer: "wf_runtime",
  subject_prefix: "workfabric.cluster.wakeup.v1",
  subject_key_id: "key1",
  allowed_tenant_ids: ["tenant-1"],
});

function fixture(options: {
  readonly failure?: Error;
  readonly contents?: string;
} = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const executions: NatsWakeupTopologyCliExecution[] = [];
  return {
    stdout,
    stderr,
    executions,
    dependencies: {
      readFile: async () => options.contents ?? config,
      execute: async (input: NatsWakeupTopologyCliExecution) => {
        executions.push(input);
        if (options.failure !== undefined) throw options.failure;
        return { mode: input.mode, actions: [] } as const;
      },
      writeStdout: (value: string) => stdout.push(value),
      writeStderr: (value: string) => stderr.push(value),
    },
  };
}

describe("nats-wakeup-topology CLI", () => {
  it("defaults to a safe plan and never emits connection or key material", async () => {
    const subjectKey = Buffer.alloc(32, 7).toString("base64url");
    const target = fixture();

    await expect(runNatsWakeupTopology(
      ["--connection-string", "nats://user:password@host:4222", "--config", "topology.json"],
      { WORK_FABRIC_NATS_SUBJECT_KEY: subjectKey },
      target.dependencies,
    )).resolves.toBe(0);
    expect(target.executions).toHaveLength(1);
    expect(target.executions[0]).toMatchObject({ mode: "plan" });
    expect(Array.from(target.executions[0]?.subject_key ?? []))
      .toEqual(Array.from(Buffer.alloc(32, 7)));
    const output = [...target.stdout, ...target.stderr].join("\n");
    expect(output).toContain('"mode":"plan"');
    expect(output).not.toContain("password");
    expect(output).not.toContain(subjectKey);
  });

  it("requires exactly one explicit mode flag when a mode is supplied", async () => {
    const subjectKey = Buffer.alloc(32, 1).toString("base64url");
    const target = fixture();
    const common = ["--connection-string", "nats://host:4222", "--config", "topology.json"];

    await expect(runNatsWakeupTopology(
      [...common, "--apply"],
      { WORK_FABRIC_NATS_SUBJECT_KEY: subjectKey },
      target.dependencies,
    )).resolves.toBe(0);
    expect(target.executions[0]?.mode).toBe("apply");

    const invalid = fixture();
    await expect(runNatsWakeupTopology(
      [...common, "--plan", "--verify"],
      { WORK_FABRIC_NATS_SUBJECT_KEY: subjectKey },
      invalid.dependencies,
    )).resolves.toBe(2);
    expect(invalid.executions).toEqual([]);
  });

  it("redacts all runtime failures and rejects missing key material", async () => {
    const subjectKey = Buffer.alloc(32, 2).toString("base64url");
    const failed = fixture({ failure: new Error("nats://user:password@host:4222") });
    const args = ["--connection-string", "nats://user:password@host:4222", "--config", "topology.json"];

    await expect(runNatsWakeupTopology(
      args,
      { WORK_FABRIC_NATS_SUBJECT_KEY: subjectKey },
      failed.dependencies,
    )).resolves.toBe(1);
    expect(failed.stderr.join("\n")).toBe("topology_failed");

    const missing = fixture();
    await expect(runNatsWakeupTopology(args, {}, missing.dependencies)).resolves.toBe(2);
    expect(missing.executions).toEqual([]);
    expect(missing.stderr.join("\n")).not.toContain("undefined");
  });
});
