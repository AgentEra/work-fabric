import { createHash } from "node:crypto";

import type {
  InvocationAuthorityProvider,
  NormalizedInvocationAuthorityRequest,
} from "@work-fabric/agent-capability-runtime";
import type { RuntimeJsonObject } from "@work-fabric/agent-runtime-spi";
import type {
  HandoffReadModel,
  RequestOptions,
} from "@work-fabric/sdk-typescript";

export interface LocalInvocationAuthorityProviderOptions {
  readonly tenant_id: string;
  readonly agent_actor_id: string;
  readonly queries: {
    getHandoff(
      handoffId: string,
      options?: RequestOptions,
    ): Promise<HandoffReadModel>;
  };
  readonly allowed_namespaces: readonly string[];
  readonly now?: () => string;
}

function record(value: unknown): Record<string, unknown> | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) return null;
  return value as Record<string, unknown>;
}

function sameCandidate(
  left: NormalizedInvocationAuthorityRequest["candidate"],
  right: NormalizedInvocationAuthorityRequest["candidate"],
): boolean {
  return (
    left.citizen_id === right.citizen_id &&
    left.endpoint_id === right.endpoint_id &&
    left.capability_id === right.capability_id &&
    left.capability_version === right.capability_version &&
    left.contract_digest === right.contract_digest
  );
}

function deny(): never {
  throw new Error("Capability authority denied");
}

const OPERATION_SCOPE = Object.freeze({
  "feishu.conversation.members.list": "conversation_members:read",
  "feishu.calendar.freebusy.query": "calendar_freebusy:read",
  "feishu.calendar.event.read": "calendar_event:read",
  "feishu.calendar.event.create": "calendar_event:write",
  "feishu.calendar.event.update": "calendar_event:write",
  "feishu.calendar.events.list": "calendar_event:read",
  "feishu.calendar.attendees.add": "calendar_attendee:write",
  "feishu.calendar.attendees.remove": "calendar_attendee:write",
  "feishu.calendar.event.delete": "calendar_event:delete",
} as const);

function requiredScope(capabilityId: string): string {
  if (capabilityId in OPERATION_SCOPE) {
    return OPERATION_SCOPE[
      capabilityId as keyof typeof OPERATION_SCOPE
    ];
  }
  if (capabilityId === "feishu.document.read") return "document:read";
  if (capabilityId === "feishu.document.delete") return "document:delete";
  if (
    capabilityId === "feishu.document.create" ||
    capabilityId === "feishu.document.update" ||
    capabilityId === "feishu.document.append"
  ) return "document:write";
  if (capabilityId === "feishu.message.send") return "message:send";
  if (capabilityId === "feishu.conversation.history.read") {
    return "conversation:read";
  }
  deny();
}

function resourceArray(value: unknown): readonly string[] | null {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    value.some((item) =>
      typeof item !== "string" ||
      item.length === 0 ||
      item.length > 2_048 ||
      item.trim() !== item
    )
  ) return null;
  return Object.freeze([...value] as string[]);
}

function stringArray(value: unknown): readonly string[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 32 ||
    value.some((item) =>
      typeof item !== "string" ||
      item.length === 0 ||
      item.length > 128
    )
  ) return null;
  return value as string[];
}

function sourceReference(value: unknown): RuntimeJsonObject | null {
  const source = record(value);
  const extensions = record(source?.extensions);
  if (
    typeof source?.uri !== "string" ||
    source.uri.length === 0 ||
    source.uri.length > 2_048 ||
    source.uri.trim() !== source.uri ||
    extensions === null ||
    Object.keys(extensions).length > 32
  ) return null;
  const safeExtensions: Record<string, string> = {};
  for (const [key, item] of Object.entries(extensions)) {
    if (
      key.length === 0 ||
      key.length > 256 ||
      typeof item !== "string" ||
      item.length === 0 ||
      item.length > 2_048
    ) return null;
    safeExtensions[key] = item;
  }
  return Object.freeze({
    uri: source.uri,
    extensions: Object.freeze(safeExtensions),
  });
}

function validFeishuConversationSource(
  value: RuntimeJsonObject,
): boolean {
  const extensions = record(value.extensions);
  return (
    typeof value.uri === "string" &&
    value.uri.startsWith("feishu://") &&
    extensions?.["workfabric.dev/provider_family"] === "feishu" &&
    extensions["workfabric.dev/resource_kind"] === "conversation_message" &&
    typeof extensions["workfabric.dev/external_tenant_id"] === "string" &&
    typeof extensions["workfabric.dev/conversation_id"] === "string" &&
    typeof extensions["workfabric.dev/message_id"] === "string"
  );
}

function currentChatReference(source: RuntimeJsonObject): string | null {
  if (!validFeishuConversationSource(source)) return null;
  const extensions = record(source.extensions);
  const conversationId = extensions?.["workfabric.dev/conversation_id"];
  return typeof conversationId === "string" &&
      conversationId.length > 0 &&
      conversationId.length <= 255
    ? `feishu://chat/${encodeURIComponent(conversationId)}`
    : null;
}

function senderReference(source: RuntimeJsonObject): string | null {
  if (!validFeishuConversationSource(source)) return null;
  const extensions = record(source.extensions);
  const sender = extensions?.["workfabric.dev/sender_resource_uri"];
  return typeof sender === "string" &&
      sender.startsWith("feishu://user/open-id/") &&
      sender.length <= 2_048
    ? sender
    : null;
}

function capabilityResult(snapshot: HandoffReadModel): {
  readonly capability_id: string;
  readonly original_handoff_id: string;
  readonly outcome: Record<string, unknown>;
} | null {
  const state = record(snapshot.state);
  const handoffPackage = record(state?.package);
  const workReference = record(handoffPackage?.work_reference);
  const extensions = record(workReference?.extensions);
  const target = record(handoffPackage?.target);
  const requirement = record(target?.capability_requirement);
  const result = record(state?.result);
  const summary = result?.summary;
  if (
    state?.lifecycle_state !== "result_returned" ||
    typeof extensions?.["workfabric.dev/original_handoff_id"] !== "string" ||
    typeof requirement?.capability_id !== "string" ||
    !Array.isArray(summary) ||
    summary.length !== 1
  ) return null;
  const content = record(summary[0]);
  const outcome = record(content?.data);
  if (
    content?.kind !== "data" ||
    content.schema_ref !== "urn:work-fabric:schema:capability-result:1" ||
    outcome === null
  ) return null;
  return {
    capability_id: requirement.capability_id,
    original_handoff_id:
      extensions["workfabric.dev/original_handoff_id"] as string,
    outcome,
  };
}

function requestedCalendarResources(
  capabilityId: string,
  input: Record<string, unknown>,
): readonly string[] {
  if (!capabilityId.startsWith("feishu.calendar.")) return [];
  const event = record(input.event);
  if (typeof event?.resource_uri === "string") {
    return Object.freeze([event.resource_uri]);
  }
  const calendar = record(input.calendar);
  return calendar?.kind === "resource_reference" &&
      typeof calendar.resource_uri === "string"
    ? Object.freeze([calendar.resource_uri])
    : Object.freeze([]);
}

export class LocalInvocationAuthorityProvider
  implements InvocationAuthorityProvider {
  private readonly now: () => string;

  constructor(
    private readonly options: LocalInvocationAuthorityProviderOptions,
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    if (
      options.tenant_id.length === 0 ||
      options.agent_actor_id.length === 0 ||
      options.allowed_namespaces.length === 0
    ) {
      throw new TypeError("Local capability Authority configuration is invalid");
    }
  }

  async authorize(
    input: NormalizedInvocationAuthorityRequest,
    signal: AbortSignal,
  ): Promise<RuntimeJsonObject> {
    if (signal.aborted) deny();
    const request = input.request;
    const expectedWorkReference =
      `urn:work-fabric:capability-invocation:${encodeURIComponent(
        request.original_handoff_id,
      )}:${encodeURIComponent(request.invocation_id)}`;
    if (
      input.tenant_id !== this.options.tenant_id ||
      request.capability_id !== input.candidate.capability_id ||
      input.work_reference_uri !== expectedWorkReference ||
      !this.options.allowed_namespaces.some((namespace) =>
        request.capability_id.startsWith(namespace)
      ) ||
      !sameCandidate(input.candidate, input.contract.candidate) ||
      !Number.isFinite(Date.parse(request.deadline)) ||
      Date.parse(request.deadline) <= Date.parse(this.now())
    ) deny();

    const snapshot = await this.options.queries.getHandoff(
      request.original_handoff_id,
      { signal },
    );
    const state = record(snapshot.state);
    const initiator = record(state?.initiator);
    const responsible = record(state?.current_responsible_actor);
    const handoffPackage = record(state?.package);
    const parentAuthority = record(handoffPackage?.authority_scope);
    const originalSource = sourceReference(handoffPackage?.work_reference);
    const originalDeadline = handoffPackage?.result_due_at;
    const parentDelegationId = parentAuthority?.delegation_id;
    const parentScopes = stringArray(parentAuthority?.scopes);
    const parentResourceRefs = stringArray(parentAuthority?.resource_refs);
    const parentExpiresAt = parentAuthority?.expires_at;
    const operationScope = requiredScope(request.capability_id);
    if (
      snapshot.tenant_id !== this.options.tenant_id ||
      snapshot.handoff_id !== request.original_handoff_id ||
      state?.lifecycle_state !== "accepted" ||
      initiator?.actor_type !== "human" ||
      typeof initiator.actor_id !== "string" ||
      initiator.actor_id.length === 0 ||
      responsible?.actor_type !== "agent" ||
      responsible.actor_id !== this.options.agent_actor_id ||
      typeof originalDeadline !== "string" ||
      !Number.isFinite(Date.parse(originalDeadline)) ||
      Date.parse(request.deadline) > Date.parse(originalDeadline) ||
      typeof parentDelegationId !== "string" ||
      parentDelegationId.length === 0 ||
      parentDelegationId.length > 128 ||
      parentScopes === null ||
      !parentScopes.includes(operationScope) ||
      originalSource === null ||
      parentResourceRefs === null ||
      !parentResourceRefs.includes(originalSource.uri as string) ||
      (
        (
          request.capability_id === "feishu.conversation.history.read" ||
          request.capability_id === "feishu.conversation.members.list" ||
          request.capability_id.startsWith("feishu.calendar.")
        ) &&
        !validFeishuConversationSource(originalSource)
      ) ||
      typeof parentExpiresAt !== "string" ||
      !Number.isFinite(Date.parse(parentExpiresAt)) ||
      Date.parse(request.deadline) > Date.parse(parentExpiresAt) ||
      parentAuthority?.may_redelegate !== true
    ) deny();

    const requestInput = record(request.input);
    if (requestInput === null) deny();
    const chatReference = currentChatReference(originalSource);
    const allowedTargets = new Set<string>();
    const allowedResources = new Set<string>();
    const confirmationProofRefs = new Set<string>();

    if (request.capability_id === "feishu.conversation.members.list") {
      const conversation = record(requestInput.conversation);
      const selected = conversation?.kind === "current_conversation"
        ? chatReference
        : conversation?.kind === "resource_reference" &&
            typeof conversation.resource_uri === "string"
        ? conversation.resource_uri
        : null;
      if (
        chatReference === null ||
        selected !== chatReference
      ) deny();
      allowedTargets.add(chatReference);
    }

    if (request.capability_id === "feishu.calendar.freebusy.query") {
      const participants = resourceArray(requestInput.participants);
      const evidence = record(requestInput.authority_evidence);
      const evidenceHandoffIds = resourceArray(
        evidence?.capability_result_handoff_ids,
      );
      if (
        chatReference === null ||
        participants === null ||
        participants.length === 0 ||
        evidenceHandoffIds === null ||
        evidenceHandoffIds.length === 0 ||
        new Set(evidenceHandoffIds).size !== evidenceHandoffIds.length
      ) deny();
      const verifiedMembers = new Set<string>();
      for (const handoffId of evidenceHandoffIds) {
        const evidenceSnapshot = await this.options.queries.getHandoff(
          handoffId,
          { signal },
        );
        const verified = capabilityResult(evidenceSnapshot);
        const outcomeData = record(verified?.outcome.data);
        const provenance = record(outcomeData?.provenance);
        const members = outcomeData?.members;
        if (
          evidenceSnapshot.tenant_id !== this.options.tenant_id ||
          evidenceSnapshot.handoff_id !== handoffId ||
          verified === null ||
          verified.original_handoff_id !== request.original_handoff_id ||
          verified.capability_id !== "feishu.conversation.members.list" ||
          verified.outcome.outcome !== "succeeded" ||
          provenance?.provider_family !== "feishu" ||
          provenance.source !== "im.chat.members" ||
          provenance.source_reference !== chatReference ||
          !Array.isArray(members)
        ) deny();
        for (const member of members) {
          const item = record(member);
          if (
            typeof item?.resource_uri !== "string" ||
            !item.resource_uri.startsWith("feishu://user/open-id/")
          ) deny();
          verifiedMembers.add(item.resource_uri);
        }
      }
      if (participants.some((resourceUri) =>
        !verifiedMembers.has(resourceUri)
      )) deny();
      for (const participant of participants) {
        allowedTargets.add(participant);
      }
    }

    if (request.capability_id === "feishu.calendar.events.list") {
      const subject = requestInput.subject_resource_uri;
      const sender = senderReference(originalSource);
      if (
        typeof subject !== "string" ||
        sender === null ||
        subject !== sender
      ) deny();
      allowedTargets.add(subject);
    }

    if (request.capability_id === "feishu.calendar.event.create") {
      const attendees = resourceArray(requestInput.attendees);
      const evidence = record(requestInput.authority_evidence);
      const sessionOriginHandoffId =
        evidence?.session_origin_handoff_id;
      const confirmationHandoffId =
        evidence?.confirmation_handoff_id;
      const proposalDigest = evidence?.proposal_digest;
      const evidenceHandoffIds = resourceArray(
        evidence?.capability_result_handoff_ids,
      );
      if (
        attendees === null ||
        typeof sessionOriginHandoffId !== "string" ||
        sessionOriginHandoffId.length === 0 ||
        sessionOriginHandoffId === request.original_handoff_id ||
        confirmationHandoffId !== request.original_handoff_id ||
        typeof proposalDigest !== "string" ||
        !/^sha256:[a-f0-9]{64}$/u.test(proposalDigest) ||
        evidenceHandoffIds === null ||
        evidenceHandoffIds.length === 0 ||
        new Set(evidenceHandoffIds).size !== evidenceHandoffIds.length
      ) deny();
      const sessionOriginSnapshot =
        await this.options.queries.getHandoff(
          sessionOriginHandoffId,
          { signal },
        );
      const originState = record(sessionOriginSnapshot.state);
      const originPackage = record(originState?.package);
      const originInitiator = record(originState?.initiator);
      const originSource = sourceReference(
        originPackage?.work_reference,
      );
      const confirmationSender = senderReference(originalSource);
      const originSender = originSource === null
        ? null
        : senderReference(originSource);
      if (
        sessionOriginSnapshot.tenant_id !== this.options.tenant_id ||
        sessionOriginSnapshot.handoff_id !== sessionOriginHandoffId ||
        (
          originState?.lifecycle_state !== "accepted" &&
          originState?.lifecycle_state !== "result_returned"
        ) ||
        originInitiator?.actor_type !== "human" ||
        originInitiator.actor_id !== initiator.actor_id ||
        originSource === null ||
        !validFeishuConversationSource(originSource) ||
        currentChatReference(originSource) !== chatReference ||
        originSender === null ||
        confirmationSender === null ||
        originSender !== confirmationSender
      ) deny();
      const verifiedMembers = new Set<string>();
      for (const handoffId of evidenceHandoffIds) {
        const evidenceSnapshot =
          await this.options.queries.getHandoff(handoffId, { signal });
        const verified = capabilityResult(evidenceSnapshot);
        if (
          evidenceSnapshot.tenant_id !== this.options.tenant_id ||
          evidenceSnapshot.handoff_id !== handoffId ||
          verified === null ||
          verified.original_handoff_id !== sessionOriginHandoffId ||
          verified.outcome.outcome !== "succeeded"
        ) deny();
        if (
          verified.capability_id ===
          "feishu.conversation.members.list"
        ) {
          const outcomeData = record(verified.outcome.data);
          const provenance = record(outcomeData?.provenance);
          const members = outcomeData?.members;
          if (
            provenance?.provider_family !== "feishu" ||
            provenance.source !== "im.chat.members" ||
            provenance.source_reference !== chatReference ||
            !Array.isArray(members)
          ) deny();
          for (const member of members) {
            const item = record(member);
            if (
              typeof item?.resource_uri !== "string" ||
              !item.resource_uri.startsWith(
                "feishu://user/open-id/",
              )
            ) deny();
            verifiedMembers.add(item.resource_uri);
          }
        } else if (
          verified.capability_id !==
          "feishu.calendar.freebusy.query"
        ) {
          deny();
        }
      }
      for (const attendee of attendees) {
        if (
          attendee === chatReference ||
          verifiedMembers.has(attendee)
        ) {
          allowedTargets.add(attendee);
        } else {
          deny();
        }
      }
      confirmationProofRefs.add(sessionOriginHandoffId);
      confirmationProofRefs.add(request.original_handoff_id);
      for (const handoffId of evidenceHandoffIds) {
        confirmationProofRefs.add(handoffId);
      }
      confirmationProofRefs.add(
        `urn:work-fabric:scheduling-proposal:${proposalDigest}`,
      );
    }

    if (
      request.capability_id === "feishu.calendar.attendees.add" ||
      request.capability_id === "feishu.calendar.attendees.remove"
    ) {
      const attendees = resourceArray(requestInput.attendees);
      if (attendees === null) deny();
      for (const attendee of attendees) {
        if (
          attendee === chatReference ||
          parentResourceRefs.includes(attendee)
        ) {
          allowedTargets.add(attendee);
        } else {
          deny();
        }
      }
    }

    for (
      const resourceUri of requestedCalendarResources(
        request.capability_id,
        requestInput,
      )
    ) {
      if (!parentResourceRefs.includes(resourceUri)) deny();
      allowedResources.add(resourceUri);
    }

    const delegationId =
      `capability-delegation-${createHash("sha256")
        .update([
          this.options.tenant_id,
          request.original_handoff_id,
          request.invocation_id,
          input.candidate.citizen_id,
          input.candidate.contract_digest,
        ].join("\u0000"))
        .digest("hex")
        .slice(0, 32)}`;
    return Object.freeze({
      delegation_id: delegationId,
      scopes: Object.freeze(["capability:invoke", operationScope]),
      resource_refs: Object.freeze([
        input.work_reference_uri,
        originalSource.uri as string,
      ]),
      expires_at: request.deadline,
      may_redelegate: false,
      extensions: Object.freeze({
        "workfabric.dev/capability_authority": Object.freeze({
          original_handoff_id: request.original_handoff_id,
          invocation_id: request.invocation_id,
          represented_actor_id: initiator.actor_id,
          delegation_id: delegationId,
          parent_delegation_id: parentDelegationId,
          delegation_scopes: Object.freeze([operationScope]),
          delegation_expires_at: request.deadline,
          capability_version: input.candidate.capability_version,
          contract_digest: input.candidate.contract_digest,
          allowed_resource_refs: Object.freeze([...allowedResources]),
          allowed_target_refs: Object.freeze([...allowedTargets]),
          confirmation_proof_refs:
            Object.freeze([...confirmationProofRefs]),
          source_reference: originalSource,
        }),
      }),
    }) as RuntimeJsonObject;
  }
}
