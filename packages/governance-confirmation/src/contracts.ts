export interface ConfirmationBinding {
  readonly tenant_id: string;
  readonly human_actor_id: string;
  readonly capability_id: string;
  readonly document_token: string;
  readonly normalized_input_digest: `sha256:${string}`;
}

export interface ConfirmationRecord extends ConfirmationBinding {
  readonly challenge_id: string;
  readonly challenge_code: string;
  readonly phrase: string;
  readonly expires_at: string;
  readonly proof_reference: string | null;
  readonly confirmed_at: string | null;
  readonly consumed_at: string | null;
}

export interface ConfirmationStore {
  put(record: ConfirmationRecord): Promise<void>;
  findPending(
    tenantId: string,
    humanActorId: string,
    phrase: string,
  ): Promise<ConfirmationRecord | null>;
  confirm(
    challengeId: string,
    proofReference: string,
    confirmedAt: string,
  ): Promise<boolean>;
  consume(
    binding: ConfirmationBinding,
    proofReference: string,
    consumedAt: string,
  ): Promise<boolean>;
}

export interface ConfirmationChallenge {
  readonly challenge_id: string;
  readonly challenge_code: string;
  readonly phrase: string;
  readonly expires_at: string;
}

export interface ConfirmationProof {
  readonly proof_reference: string;
  readonly challenge_id: string;
  readonly expires_at: string;
}
