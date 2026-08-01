import { randomBytes, randomUUID } from "node:crypto";

import type {
  ConfirmationBinding,
  ConfirmationChallenge,
  ConfirmationProof,
  ConfirmationStore,
} from "./contracts.js";

export interface ConfirmationServiceOptions {
  readonly store: ConfirmationStore;
  readonly challenge_ttl_seconds: number;
  readonly now?: () => string;
  readonly next_id?: (kind: "challenge" | "proof") => string;
  readonly next_code?: () => string;
}

export class ConfirmationService {
  private readonly now: () => string;
  private readonly nextId: (kind: "challenge" | "proof") => string;
  private readonly nextCode: () => string;

  constructor(private readonly options: ConfirmationServiceOptions) {
    if (
      !Number.isSafeInteger(options.challenge_ttl_seconds) ||
      options.challenge_ttl_seconds < 1 ||
      options.challenge_ttl_seconds > 3_600
    ) throw new RangeError("confirmation challenge TTL is invalid");
    this.now = options.now ?? (() => new Date().toISOString());
    this.nextId = options.next_id ?? ((kind) => `${kind}-${randomUUID()}`);
    this.nextCode = options.next_code ??
      (() => randomBytes(4).toString("hex").toUpperCase());
  }

  async issue(binding: ConfirmationBinding): Promise<ConfirmationChallenge> {
    const now = this.now();
    const challengeId = this.nextId("challenge");
    const challengeCode = this.nextCode();
    const expiresAt = new Date(
      Date.parse(now) + this.options.challenge_ttl_seconds * 1_000,
    ).toISOString();
    const phrase = `确认删除 ${challengeCode}`;
    await this.options.store.put({
      ...binding,
      challenge_id: challengeId,
      challenge_code: challengeCode,
      phrase,
      expires_at: expiresAt,
      proof_reference: null,
      confirmed_at: null,
      consumed_at: null,
    });
    return {
      challenge_id: challengeId,
      challenge_code: challengeCode,
      phrase,
      expires_at: expiresAt,
    };
  }

  async confirm(input: {
    readonly tenant_id: string;
    readonly human_actor_id: string;
    readonly message_text: string;
  }): Promise<ConfirmationProof | null> {
    const now = this.now();
    const pending = await this.options.store.findPending(
      input.tenant_id,
      input.human_actor_id,
      input.message_text,
    );
    if (pending === null || pending.expires_at <= now) return null;
    const proofReference = this.nextId("proof");
    if (!await this.options.store.confirm(
      pending.challenge_id,
      proofReference,
      now,
    )) return null;
    return {
      proof_reference: proofReference,
      challenge_id: pending.challenge_id,
      expires_at: pending.expires_at,
    };
  }

  consume(input: ConfirmationBinding & {
    readonly proof_reference: string;
  }): Promise<boolean> {
    const { proof_reference: proofReference, ...binding } = input;
    return this.options.store.consume(binding, proofReference, this.now());
  }
}
