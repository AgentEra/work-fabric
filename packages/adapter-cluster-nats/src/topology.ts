import {
  JetStreamApiCodes,
  JetStreamApiError,
  type ConsumerConfig,
  type JetStreamManager,
  type StreamConfig,
} from "@nats-io/jetstream";

import { NatsWakeupError } from "./errors.js";
import { NATS_WAKEUP_MAX_BYTES } from "./wakeup-codec.js";

const namePattern = /^[A-Za-z0-9_-]{1,64}$/;
const subjectTokenPattern = /^[A-Za-z0-9_-]{1,64}$/;
const nanosecondsPerSecond = 1_000_000_000;

export interface NatsWakeupTopologyInput {
  readonly stream: string;
  readonly consumer: string;
  readonly subject_prefix: string;
  readonly filter_subjects: readonly string[];
  readonly max_age_seconds?: number;
  readonly max_bytes?: number;
  readonly replicas?: number;
  readonly ack_wait_seconds?: number;
  readonly max_deliver?: number;
  readonly max_ack_pending?: number;
  readonly max_waiting?: number;
}

export interface NatsTopologyStream {
  readonly name: string;
  readonly subjects: readonly string[];
  readonly retention: "limits" | "interest" | "workqueue";
  readonly storage: "file" | "memory";
  readonly discard: "old" | "new";
  readonly max_msg_size: number;
  readonly max_age_nanoseconds: number;
  readonly max_bytes: number;
  readonly duplicate_window_nanoseconds: number;
  readonly num_replicas: number;
}

export interface NatsTopologyConsumer {
  readonly stream: string;
  readonly name: string;
  readonly durable_name: string;
  readonly filter_subjects: readonly string[];
  readonly ack_policy: "none" | "all" | "explicit" | "";
  readonly deliver_policy:
    | "all" | "last" | "new" | "by_start_sequence" | "by_start_time"
    | "last_per_subject";
  readonly replay_policy: "instant" | "original";
  readonly ack_wait_nanoseconds: number;
  readonly max_deliver: number;
  readonly max_ack_pending: number;
  readonly max_waiting: number;
  readonly num_replicas: number;
  readonly memory_storage: boolean;
}

export interface NatsWakeupTopology {
  readonly stream: NatsTopologyStream;
  readonly consumer: NatsTopologyConsumer;
}

export type NatsTopologyMode = "plan" | "verify" | "apply";

export interface NatsTopologyAction {
  readonly resource: "stream" | "consumer";
  readonly action: "create" | "update";
}

export interface NatsTopologyResult {
  readonly mode: NatsTopologyMode;
  readonly actions: readonly NatsTopologyAction[];
}

export interface NatsTopologyManagementPort {
  readStream(name: string): Promise<NatsTopologyStream | null>;
  createStream(stream: NatsTopologyStream): Promise<void>;
  updateStream(stream: NatsTopologyStream): Promise<void>;
  readConsumer(stream: string, consumer: string): Promise<NatsTopologyConsumer | null>;
  createConsumer(consumer: NatsTopologyConsumer): Promise<void>;
  updateConsumer(consumer: NatsTopologyConsumer): Promise<void>;
}

function bounded(
  value: number | undefined,
  fallback: number,
  field: string,
  minimum: number,
  maximum: number,
): number {
  const normalized = value ?? fallback;
  if (
    !Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum
  ) throw new RangeError(`${field} must be between ${minimum} and ${maximum}`);
  return normalized;
}

function name(value: string, field: string): string {
  if (!namePattern.test(value)) throw new TypeError(`${field} is invalid`);
  return value;
}

function prefix(value: string): string {
  if (
    value.length === 0 || value.length > 320 ||
    !value.split(".").every((token) => subjectTokenPattern.test(token))
  ) throw new TypeError("subject_prefix is invalid");
  return value;
}

function filters(values: readonly string[], subjectPrefix: string): readonly string[] {
  if (
    !Array.isArray(values) || values.length < 4 || values.length > 1_000 ||
    values.length % 4 !== 0
  ) throw new RangeError("filter_subjects must contain 4 to 1000 subjects");
  const expectedTokens = subjectPrefix.split(".").length + 3;
  const stringValues = values.filter(
    (value: unknown): value is string => typeof value === "string",
  );
  const normalized = [...new Set(stringValues)];
  if (
    normalized.length !== values.length ||
    normalized.some((subject) => {
      const tokens = subject.split(".");
      return tokens.length !== expectedTokens ||
        !subject.startsWith(`${subjectPrefix}.`) ||
        !tokens.every((token) => subjectTokenPattern.test(token));
    })
  ) throw new TypeError("filter_subjects is invalid");
  return normalized.sort();
}

export function desiredNatsWakeupTopology(
  input: NatsWakeupTopologyInput,
): NatsWakeupTopology {
  const stream = name(input.stream, "stream");
  const consumer = name(input.consumer, "consumer");
  const subjectPrefix = prefix(input.subject_prefix);
  const filterSubjects = filters(input.filter_subjects, subjectPrefix);
  const maxAgeSeconds = bounded(
    input.max_age_seconds,
    900,
    "max_age_seconds",
    60,
    86_400,
  );
  const maxBytes = bounded(
    input.max_bytes,
    256 * 1_024 * 1_024,
    "max_bytes",
    1 * 1_024 * 1_024,
    10 * 1_024 * 1_024 * 1_024,
  );
  const replicas = bounded(input.replicas, 3, "replicas", 1, 5);
  const ackWaitSeconds = bounded(
    input.ack_wait_seconds,
    30,
    "ack_wait_seconds",
    5,
    300,
  );
  return {
    stream: {
      name: stream,
      subjects: [`${subjectPrefix}.*.*.*`],
      retention: "limits",
      storage: "file",
      discard: "old",
      max_msg_size: NATS_WAKEUP_MAX_BYTES,
      max_age_nanoseconds: maxAgeSeconds * nanosecondsPerSecond,
      max_bytes: maxBytes,
      duplicate_window_nanoseconds: 120 * nanosecondsPerSecond,
      num_replicas: replicas,
    },
    consumer: {
      stream,
      name: consumer,
      durable_name: consumer,
      filter_subjects: filterSubjects,
      ack_policy: "explicit",
      deliver_policy: "new",
      replay_policy: "instant",
      ack_wait_nanoseconds: ackWaitSeconds * nanosecondsPerSecond,
      max_deliver: bounded(input.max_deliver, 5, "max_deliver", 1, 20),
      max_ack_pending: bounded(
        input.max_ack_pending,
        1_024,
        "max_ack_pending",
        1,
        10_000,
      ),
      max_waiting: bounded(input.max_waiting, 32, "max_waiting", 1, 256),
      num_replicas: 0,
      memory_storage: false,
    },
  };
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertCompatibleStream(
  current: NatsTopologyStream,
  desired: NatsTopologyStream,
): void {
  if (
    !same(current.subjects, desired.subjects) ||
    current.retention !== desired.retention ||
    current.storage !== desired.storage
  ) throw new NatsWakeupError("wakeup_topology_drift");
}

export async function reconcileNatsWakeupTopology(
  port: NatsTopologyManagementPort,
  desired: NatsWakeupTopology,
  mode: NatsTopologyMode,
): Promise<NatsTopologyResult> {
  if (!(["plan", "verify", "apply"] as const).includes(mode)) {
    throw new TypeError("topology mode is invalid");
  }
  const [currentStream, currentConsumer] = await Promise.all([
    port.readStream(desired.stream.name),
    port.readConsumer(desired.stream.name, desired.consumer.name),
  ]);
  if (currentStream !== null) assertCompatibleStream(currentStream, desired.stream);

  const actions: NatsTopologyAction[] = [];
  if (currentStream === null) actions.push({ resource: "stream", action: "create" });
  else if (!same(currentStream, desired.stream)) {
    actions.push({ resource: "stream", action: "update" });
  }
  if (currentConsumer === null) {
    actions.push({ resource: "consumer", action: "create" });
  } else if (!same(currentConsumer, desired.consumer)) {
    actions.push({ resource: "consumer", action: "update" });
  }

  if (mode === "verify" && actions.length > 0) {
    throw new NatsWakeupError("wakeup_topology_drift");
  }
  if (mode === "apply") {
    for (const action of actions) {
      if (action.resource === "stream") {
        if (action.action === "create") await port.createStream(desired.stream);
        else await port.updateStream(desired.stream);
      } else if (action.action === "create") {
        await port.createConsumer(desired.consumer);
      } else {
        await port.updateConsumer(desired.consumer);
      }
    }
  }
  return { mode, actions };
}

function isNotFound(error: unknown, code: number): boolean {
  return error instanceof JetStreamApiError && error.code === code;
}

function streamConfig(stream: NatsTopologyStream): Partial<StreamConfig> & { name: string } {
  return {
    name: stream.name,
    subjects: [...stream.subjects],
    retention: stream.retention,
    storage: stream.storage,
    discard: stream.discard,
    max_msg_size: stream.max_msg_size,
    max_age: stream.max_age_nanoseconds,
    max_bytes: stream.max_bytes,
    duplicate_window: stream.duplicate_window_nanoseconds,
    num_replicas: stream.num_replicas,
  };
}

function consumerConfig(consumer: NatsTopologyConsumer): Partial<ConsumerConfig> {
  return {
    name: consumer.name,
    durable_name: consumer.durable_name,
    filter_subjects: [...consumer.filter_subjects],
    ack_policy: consumer.ack_policy,
    deliver_policy: consumer.deliver_policy,
    replay_policy: consumer.replay_policy,
    ack_wait: consumer.ack_wait_nanoseconds,
    max_deliver: consumer.max_deliver,
    max_ack_pending: consumer.max_ack_pending,
    max_waiting: consumer.max_waiting,
    num_replicas: consumer.num_replicas,
    mem_storage: consumer.memory_storage,
  };
}

export class NatsJetStreamTopologyPort implements NatsTopologyManagementPort {
  constructor(private readonly manager: JetStreamManager) {}

  async readStream(name: string): Promise<NatsTopologyStream | null> {
    try {
      const config = (await this.manager.streams.info(name)).config;
      return {
        name: config.name,
        subjects: [...config.subjects].sort(),
        retention: config.retention,
        storage: config.storage,
        discard: config.discard,
        max_msg_size: config.max_msg_size,
        max_age_nanoseconds: config.max_age,
        max_bytes: config.max_bytes,
        duplicate_window_nanoseconds: config.duplicate_window,
        num_replicas: config.num_replicas,
      };
    } catch (error) {
      if (isNotFound(error, JetStreamApiCodes.StreamNotFound)) return null;
      throw new NatsWakeupError("wakeup_transport_unavailable");
    }
  }

  async createStream(stream: NatsTopologyStream): Promise<void> {
    try { await this.manager.streams.add(streamConfig(stream)); } catch {
      throw new NatsWakeupError("wakeup_transport_unavailable");
    }
  }

  async updateStream(stream: NatsTopologyStream): Promise<void> {
    try { await this.manager.streams.update(stream.name, streamConfig(stream)); } catch {
      throw new NatsWakeupError("wakeup_transport_unavailable");
    }
  }

  async readConsumer(
    stream: string,
    consumer: string,
  ): Promise<NatsTopologyConsumer | null> {
    try {
      const config = (await this.manager.consumers.info(stream, consumer)).config;
      return {
        stream,
        name: config.name ?? consumer,
        durable_name: config.durable_name ?? consumer,
        filter_subjects: [...(
          config.filter_subjects ??
          (config.filter_subject === undefined ? [] : [config.filter_subject])
        )].sort(),
        ack_policy: config.ack_policy,
        deliver_policy: config.deliver_policy,
        replay_policy: config.replay_policy,
        ack_wait_nanoseconds: config.ack_wait ?? 0,
        max_deliver: config.max_deliver ?? -1,
        max_ack_pending: config.max_ack_pending ?? 0,
        max_waiting: config.max_waiting ?? 0,
        num_replicas: config.num_replicas ?? 0,
        memory_storage: config.mem_storage ?? false,
      };
    } catch (error) {
      if (
        isNotFound(error, JetStreamApiCodes.ConsumerNotFound) ||
        isNotFound(error, JetStreamApiCodes.StreamNotFound)
      ) return null;
      throw new NatsWakeupError("wakeup_transport_unavailable");
    }
  }

  async createConsumer(consumer: NatsTopologyConsumer): Promise<void> {
    try {
      await this.manager.consumers.add(consumer.stream, consumerConfig(consumer));
    } catch {
      throw new NatsWakeupError("wakeup_transport_unavailable");
    }
  }

  async updateConsumer(consumer: NatsTopologyConsumer): Promise<void> {
    try {
      await this.manager.consumers.update(
        consumer.stream,
        consumer.durable_name,
        consumerConfig(consumer),
      );
    } catch {
      throw new NatsWakeupError("wakeup_transport_unavailable");
    }
  }
}
