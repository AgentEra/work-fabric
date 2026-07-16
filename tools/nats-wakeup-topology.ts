import { readFile } from "node:fs/promises";

import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import {
  HmacWakeupSubjectCodec,
  NatsJetStreamTopologyPort,
  NatsWakeupError,
  desiredNatsWakeupTopology,
  reconcileNatsWakeupTopology,
  type NatsTopologyMode,
  type NatsTopologyResult,
  type NatsWakeupTopologyInput,
} from "@work-fabric/adapter-cluster-nats";

interface NatsWakeupTopologyFile extends Omit<
  NatsWakeupTopologyInput,
  "filter_subjects"
> {
  readonly subject_key_id: string;
  readonly allowed_tenant_ids: readonly string[];
}

export interface NatsWakeupTopologyCliExecution {
  readonly connection_string: string;
  readonly mode: NatsTopologyMode;
  readonly config: NatsWakeupTopologyFile;
  readonly subject_key: Uint8Array;
}

export interface NatsWakeupTopologyCliDependencies {
  readonly readFile: (path: string) => Promise<string>;
  readonly execute: (
    input: NatsWakeupTopologyCliExecution,
  ) => Promise<NatsTopologyResult>;
  readonly writeStdout: (value: string) => void;
  readonly writeStderr: (value: string) => void;
}

const allowedConfigKeys = new Set([
  "stream",
  "consumer",
  "subject_prefix",
  "subject_key_id",
  "allowed_tenant_ids",
  "max_age_seconds",
  "max_bytes",
  "replicas",
  "ack_wait_seconds",
  "max_deliver",
  "max_ack_pending",
  "max_waiting",
]);

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("topology_config_invalid");
  }
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !allowedConfigKeys.has(key))) {
    throw new TypeError("topology_config_invalid");
  }
  return result;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("topology_config_invalid");
  }
  return value;
}

function optionalNumber(
  source: Record<string, unknown>,
  key: string,
): Record<string, number> {
  const value = source[key];
  if (value === undefined) return {};
  if (typeof value !== "number") throw new TypeError("topology_config_invalid");
  return { [key]: value };
}

function parseConfig(text: string): NatsWakeupTopologyFile {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new TypeError("topology_config_invalid"); }
  const source = record(parsed);
  if (
    !Array.isArray(source.allowed_tenant_ids) ||
    source.allowed_tenant_ids.some((value: unknown) => typeof value !== "string")
  ) throw new TypeError("topology_config_invalid");
  return {
    stream: requiredString(source.stream),
    consumer: requiredString(source.consumer),
    subject_prefix: requiredString(source.subject_prefix),
    subject_key_id: requiredString(source.subject_key_id),
    allowed_tenant_ids: [...source.allowed_tenant_ids] as string[],
    ...optionalNumber(source, "max_age_seconds"),
    ...optionalNumber(source, "max_bytes"),
    ...optionalNumber(source, "replicas"),
    ...optionalNumber(source, "ack_wait_seconds"),
    ...optionalNumber(source, "max_deliver"),
    ...optionalNumber(source, "max_ack_pending"),
    ...optionalNumber(source, "max_waiting"),
  };
}

function parseKey(value: string | undefined): Uint8Array {
  if (value === undefined || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError("subject_key_required");
  }
  const bytes = Buffer.from(value, "base64url");
  if (
    bytes.byteLength < 32 || bytes.byteLength > 128 ||
    bytes.toString("base64url") !== value
  ) throw new TypeError("subject_key_required");
  return Uint8Array.from(bytes);
}

function args(argv: readonly string[]): {
  readonly connection: string;
  readonly config: string;
  readonly mode: NatsTopologyMode;
} {
  let connection: string | undefined;
  let config: string | undefined;
  const modes: NatsTopologyMode[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--connection-string" || argument === "--config") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new TypeError("invalid_arguments");
      }
      if (argument === "--connection-string") connection = value;
      else config = value;
      index += 1;
    } else if (argument === "--plan") modes.push("plan");
    else if (argument === "--verify") modes.push("verify");
    else if (argument === "--apply") modes.push("apply");
    else throw new TypeError("invalid_arguments");
  }
  if (
    connection === undefined || connection.length === 0 ||
    config === undefined || config.length === 0 || modes.length > 1
  ) throw new TypeError("invalid_arguments");
  return { connection, config, mode: modes[0] ?? "plan" };
}

export async function executeNatsWakeupTopology(
  input: NatsWakeupTopologyCliExecution,
): Promise<NatsTopologyResult> {
  const connection = await connect({ servers: input.connection_string });
  try {
    const subjects = new HmacWakeupSubjectCodec({
      subject_prefix: input.config.subject_prefix,
      subject_key_id: input.config.subject_key_id,
      subject_key: input.subject_key,
      allowed_tenant_ids: input.config.allowed_tenant_ids,
    });
    const desired = desiredNatsWakeupTopology({
      ...input.config,
      filter_subjects: subjects.filterSubjects(),
    });
    const manager = await jetstreamManager(connection);
    return await reconcileNatsWakeupTopology(
      new NatsJetStreamTopologyPort(manager),
      desired,
      input.mode,
    );
  } finally {
    await connection.drain();
  }
}

const defaultDependencies: NatsWakeupTopologyCliDependencies = {
  readFile: (path) => readFile(path, "utf8"),
  execute: executeNatsWakeupTopology,
  writeStdout: (value) => process.stdout.write(`${value}\n`),
  writeStderr: (value) => process.stderr.write(`${value}\n`),
};

export async function runNatsWakeupTopology(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: NatsWakeupTopologyCliDependencies = defaultDependencies,
): Promise<number> {
  let parsedArgs: ReturnType<typeof args>;
  let subjectKey: Uint8Array;
  try {
    parsedArgs = args(argv);
    subjectKey = parseKey(environment.WORK_FABRIC_NATS_SUBJECT_KEY);
  } catch (error) {
    dependencies.writeStderr(error instanceof Error ? error.message : "invalid_arguments");
    return 2;
  }
  try {
    const config = parseConfig(await dependencies.readFile(parsedArgs.config));
    const result = await dependencies.execute({
      connection_string: parsedArgs.connection,
      mode: parsedArgs.mode,
      config,
      subject_key: subjectKey,
    });
    dependencies.writeStdout(JSON.stringify(result));
    return 0;
  } catch (error) {
    dependencies.writeStderr(
      error instanceof NatsWakeupError ? error.code : "topology_failed",
    );
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runNatsWakeupTopology(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  }).catch(() => {
    process.stderr.write("topology_failed\n");
    process.exitCode = 1;
  });
}
