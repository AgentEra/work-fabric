import { createHash } from "node:crypto";

import type {
  AgentPrivateStateStore,
  RuntimeJsonObject,
  RuntimeJsonValue,
  RuntimeTaskPackage,
} from "@work-fabric/agent-runtime-spi";

export const SCHEDULING_SESSION_NAMESPACE =
  "daily-assistant.scheduling/v1";

export type SchedulingPhase =
  | "collecting_information"
  | "proposal_ready"
  | "awaiting_confirmation"
  | "executing"
  | "completed"
  | "cancelled";

export interface SchedulingProposalInput {
  readonly version: number;
  readonly title: string;
  readonly participant_resource_uris: readonly string[];
  readonly start_at: string;
  readonly end_at: string;
  readonly timezone: string;
  readonly summary_markdown: string;
}

export interface SchedulingProposal extends SchedulingProposalInput {
  readonly digest: `sha256:${string}`;
}

export interface SchedulingSession {
  readonly version: number;
  readonly phase: SchedulingPhase;
  readonly correlation_key: string;
  readonly conversation_resource_uri: string;
  readonly origin_handoff_id: string;
  readonly origin_initiator_actor_id: string;
  readonly origin_sender_resource_uri: string;
  readonly proposal: SchedulingProposal | null;
  readonly confirmed_proposal_digest: string | null;
  readonly confirmation_handoff_id: string | null;
  readonly calendar_result_uri: string | null;
  readonly capability_result_handoff_ids: readonly string[];
  readonly created_at: string;
  readonly updated_at: string;
}

export interface SchedulingSessionUpdate {
  readonly namespace: typeof SCHEDULING_SESSION_NAMESPACE;
  readonly expected_version: number;
  readonly phase: SchedulingPhase;
  readonly proposal: SchedulingProposalInput | null;
  readonly confirmed_proposal_digest: string | null;
  readonly confirmation_handoff_id: string | null;
  readonly calendar_result_uri: string | null;
  readonly capability_result_handoff_ids: readonly string[];
}

export interface SchedulingCorrelation {
  readonly key: string;
  readonly conversation_resource_uri: string;
  readonly sender_resource_uri: string;
}

const SCHEDULING_PHASES = new Set<SchedulingPhase>([
  "collecting_information",
  "proposal_ready",
  "awaiting_confirmation",
  "executing",
  "completed",
  "cancelled",
]);

function record(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function string(
  value: unknown,
  field: string,
  maximum = 2_048,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, field: string): string {
  const result = string(value, field, 128);
  if (!Number.isFinite(Date.parse(result))) {
    throw new TypeError(`${field} is invalid`);
  }
  return new Date(Date.parse(result)).toISOString();
}

function markdown(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") {
    throw new TypeError(`${field} is invalid`);
  }
  const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (
    normalized.length === 0 ||
    normalized.length > maximum ||
    normalized.trim() !== normalized ||
    /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  return normalized;
}

function handoffIds(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > 8 ||
    value.some((item) =>
      typeof item !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u.test(item)
    ) ||
    new Set(value).size !== value.length
  ) {
    throw new TypeError("capability result Handoff IDs are invalid");
  }
  return Object.freeze([...value] as string[]);
}

function sourceFacts(task: RuntimeTaskPackage): {
  readonly extensions: Record<string, unknown>;
  readonly actor_id: string;
} {
  const source = record(task.source_reference, "source_reference");
  const extensions = record(
    source.extensions,
    "source_reference.extensions",
  );
  if (
    extensions["workfabric.dev/provider_family"] !== "feishu" ||
    extensions["workfabric.dev/resource_kind"] !== "conversation_message"
  ) {
    throw new TypeError("scheduling source is not a Feishu message");
  }
  const initiator = record(task.initiator, "initiator");
  if (initiator.actor_type !== "human") {
    throw new TypeError("scheduling initiator must be Human");
  }
  return {
    extensions,
    actor_id: string(initiator.actor_id, "initiator.actor_id", 128),
  };
}

export function schedulingCorrelation(
  task: RuntimeTaskPackage,
): SchedulingCorrelation {
  const { extensions } = sourceFacts(task);
  const conversationResourceUri = string(
    extensions["workfabric.dev/conversation_resource_uri"],
    "conversation_resource_uri",
  );
  const senderResourceUri = string(
    extensions["workfabric.dev/sender_resource_uri"],
    "sender_resource_uri",
  );
  const key =
    `feishu:conversation:${encodeURIComponent(conversationResourceUri)}`;
  return {
    key,
    conversation_resource_uri: conversationResourceUri,
    sender_resource_uri: senderResourceUri,
  };
}

function canonical(value: RuntimeJsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  const object = value as RuntimeJsonObject;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(object[key]!)}`
  ).join(",")}}`;
}

function proposal(input: SchedulingProposalInput): SchedulingProposal {
  if (
    !Number.isSafeInteger(input.version) ||
    input.version < 1 ||
    input.version > 1_000
  ) {
    throw new TypeError("proposal.version is invalid");
  }
  const participantResourceUris = [...input.participant_resource_uris];
  if (
    participantResourceUris.length === 0 ||
    participantResourceUris.length > 100 ||
    new Set(participantResourceUris).size !== participantResourceUris.length
  ) {
    throw new TypeError("proposal participants are invalid");
  }
  for (const resourceUri of participantResourceUris) {
    if (!string(resourceUri, "proposal participant").startsWith(
      "feishu://user/open-id/",
    )) {
      throw new TypeError("proposal participant is invalid");
    }
  }
  const startAt = timestamp(input.start_at, "proposal.start_at");
  const endAt = timestamp(input.end_at, "proposal.end_at");
  if (Date.parse(endAt) <= Date.parse(startAt)) {
    throw new TypeError("proposal time range is invalid");
  }
  const normalized: SchedulingProposalInput = {
    version: input.version,
    title: string(input.title, "proposal.title", 512),
    participant_resource_uris: participantResourceUris,
    start_at: startAt,
    end_at: endAt,
    timezone: string(input.timezone, "proposal.timezone", 128),
    summary_markdown: markdown(
      input.summary_markdown,
      "proposal.summary_markdown",
      16_384,
    ),
  };
  const digest = `sha256:${createHash("sha256")
    .update(canonical(normalized as unknown as RuntimeJsonObject))
    .digest("hex")}` as const;
  return { ...normalized, digest };
}

function sessionFromValue(
  version: number,
  value: RuntimeJsonObject,
): SchedulingSession {
  const item = record(value, "scheduling session");
  if (
    typeof item.phase !== "string" ||
    !SCHEDULING_PHASES.has(item.phase as SchedulingPhase)
  ) {
    throw new TypeError("scheduling session phase is invalid");
  }
  const normalizedProposal = item.proposal === null
    ? null
    : proposal(record(
      item.proposal,
      "scheduling session proposal",
    ) as unknown as SchedulingProposalInput);
  if (
    item.proposal !== null &&
    record(item.proposal, "scheduling session proposal").digest !==
      normalizedProposal?.digest
  ) {
    throw new TypeError("scheduling session proposal digest is invalid");
  }
  return {
    version,
    phase: item.phase as SchedulingPhase,
    correlation_key: string(item.correlation_key, "correlation_key"),
    conversation_resource_uri: string(
      item.conversation_resource_uri,
      "conversation_resource_uri",
    ),
    origin_handoff_id: string(
      item.origin_handoff_id,
      "origin_handoff_id",
      128,
    ),
    origin_initiator_actor_id: string(
      item.origin_initiator_actor_id,
      "origin_initiator_actor_id",
      128,
    ),
    origin_sender_resource_uri: string(
      item.origin_sender_resource_uri,
      "origin_sender_resource_uri",
    ),
    proposal: normalizedProposal,
    confirmed_proposal_digest: item.confirmed_proposal_digest === null
      ? null
      : string(
        item.confirmed_proposal_digest,
        "confirmed_proposal_digest",
        80,
      ),
    confirmation_handoff_id: item.confirmation_handoff_id === null
      ? null
      : string(item.confirmation_handoff_id, "confirmation_handoff_id", 128),
    calendar_result_uri: item.calendar_result_uri === null
      ? null
      : string(item.calendar_result_uri, "calendar_result_uri"),
    capability_result_handoff_ids: handoffIds(
      item.capability_result_handoff_ids,
    ),
    created_at: timestamp(item.created_at, "created_at"),
    updated_at: timestamp(item.updated_at, "updated_at"),
  };
}

export class SchedulingSessionRepository {
  private readonly now: () => string;

  constructor(
    private readonly store: AgentPrivateStateStore,
    options: { readonly now?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async context(task: RuntimeTaskPackage): Promise<RuntimeJsonObject> {
    const correlation = schedulingCorrelation(task);
    const source = sourceFacts(task);
    const record = await this.store.getPrivateState(
      task.tenant_id,
      SCHEDULING_SESSION_NAMESPACE,
      correlation.key,
    );
    const storedSession = record === null
      ? null
      : sessionFromValue(record.version, record.value);
    const activeSession =
      storedSession?.phase === "completed" ||
        storedSession?.phase === "cancelled"
        ? null
        : storedSession;
    return {
      namespace: SCHEDULING_SESSION_NAMESPACE,
      correlation_key: correlation.key,
      state_version: record?.version ?? 0,
      current_source: {
        handoff_id: task.handoff_id,
        actor_id: source.actor_id,
        sender_resource_uri: correlation.sender_resource_uri,
        conversation_resource_uri: correlation.conversation_resource_uri,
      },
      original_initiator: activeSession === null
        ? {
            actor_id: source.actor_id,
            sender_resource_uri: correlation.sender_resource_uri,
          }
        : {
            actor_id: activeSession.origin_initiator_actor_id,
            sender_resource_uri: activeSession.origin_sender_resource_uri,
          },
      active_session: activeSession as unknown as RuntimeJsonValue,
    };
  }

  async apply(
    task: RuntimeTaskPackage,
    update: SchedulingSessionUpdate,
  ): Promise<SchedulingSession> {
    if (update.namespace !== SCHEDULING_SESSION_NAMESPACE) {
      throw new TypeError("Agent private state namespace is invalid");
    }
    const correlation = schedulingCorrelation(task);
    const currentRecord = await this.store.getPrivateState(
      task.tenant_id,
      SCHEDULING_SESSION_NAMESPACE,
      correlation.key,
    );
    const stored = currentRecord === null
      ? null
      : sessionFromValue(currentRecord.version, currentRecord.value);
    const current =
      stored?.phase === "completed" || stored?.phase === "cancelled"
        ? null
        : stored;
    if (update.expected_version !== (stored?.version ?? 0)) {
      throw new TypeError("Agent private state expected version is invalid");
    }
    const source = sourceFacts(task);
    const normalizedProposal = update.proposal === null
      ? current?.proposal ?? null
      : proposal(update.proposal);
    if (update.proposal !== null) {
      const expectedProposalVersion = (current?.proposal?.version ?? 0) + 1;
      if (normalizedProposal?.version !== expectedProposalVersion) {
        throw new TypeError("proposal version is invalid");
      }
    }
    if (
      update.phase === "awaiting_confirmation" &&
      (
        update.proposal === null ||
        normalizedProposal === null ||
        update.confirmed_proposal_digest !== null ||
        update.confirmation_handoff_id !== null ||
        update.calendar_result_uri !== null
        || update.capability_result_handoff_ids.length === 0
      )
    ) {
      throw new TypeError("awaiting confirmation state is invalid");
    }
    if (
      current !== null &&
      update.phase === "awaiting_confirmation" &&
      (
        source.actor_id !== current.origin_initiator_actor_id ||
        correlation.sender_resource_uri !==
          current.origin_sender_resource_uri
      )
    ) {
      throw new TypeError(
        "only the original initiator may revise the current proposal",
      );
    }
    if (update.phase === "cancelled") {
      if (
        current === null ||
        current.phase !== "awaiting_confirmation" ||
        current.proposal === null ||
        source.actor_id !== current.origin_initiator_actor_id ||
        correlation.sender_resource_uri !==
          current.origin_sender_resource_uri
      ) {
        throw new TypeError(
          "only the original initiator may cancel the active proposal",
        );
      }
      if (
        update.proposal !== null ||
        update.confirmed_proposal_digest !== null ||
        update.confirmation_handoff_id !== null ||
        update.calendar_result_uri !== null ||
        update.capability_result_handoff_ids.length !== 0
      ) {
        throw new TypeError("cancelled proposal state is invalid");
      }
    }
    if (update.phase === "completed" || update.phase === "executing") {
      if (
        current === null ||
        current.proposal === null ||
        source.actor_id !== current.origin_initiator_actor_id ||
        correlation.sender_resource_uri !==
          current.origin_sender_resource_uri ||
        update.confirmed_proposal_digest !== current.proposal.digest ||
        update.confirmation_handoff_id !== task.handoff_id ||
        update.capability_result_handoff_ids.length !==
          current.capability_result_handoff_ids.length ||
        update.capability_result_handoff_ids.some(
          (handoffId, index) =>
            handoffId !== current.capability_result_handoff_ids[index],
        ) ||
        (
          update.phase === "completed" &&
          update.calendar_result_uri === null
        )
      ) {
        throw new TypeError(
          "only the original initiator may confirm the current proposal",
        );
      }
    }
    const now = timestamp(this.now(), "now");
    const value: RuntimeJsonObject = {
      phase: update.phase,
      correlation_key: correlation.key,
      conversation_resource_uri:
        current?.conversation_resource_uri ??
        correlation.conversation_resource_uri,
      origin_handoff_id: current?.origin_handoff_id ?? task.handoff_id,
      origin_initiator_actor_id:
        current?.origin_initiator_actor_id ?? source.actor_id,
      origin_sender_resource_uri:
        current?.origin_sender_resource_uri ??
        correlation.sender_resource_uri,
      proposal: normalizedProposal as unknown as RuntimeJsonValue,
      confirmed_proposal_digest: update.confirmed_proposal_digest,
      confirmation_handoff_id: update.confirmation_handoff_id,
      calendar_result_uri: update.calendar_result_uri,
      capability_result_handoff_ids: handoffIds(
        update.capability_result_handoff_ids,
      ),
      created_at: current?.created_at ?? now,
      updated_at: now,
    };
    const saved = await this.store.putPrivateState({
      tenant_id: task.tenant_id,
      namespace: SCHEDULING_SESSION_NAMESPACE,
      key: correlation.key,
      expected_version: update.expected_version,
      value,
      updated_at: now,
    });
    return sessionFromValue(saved.version, saved.value);
  }
}
