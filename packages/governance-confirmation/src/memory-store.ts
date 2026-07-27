import type {
  ConfirmationBinding,
  ConfirmationRecord,
  ConfirmationStore,
} from "./contracts.js";

function clone(record: ConfirmationRecord): ConfirmationRecord {
  return structuredClone(record);
}

function matches(
  record: ConfirmationRecord,
  binding: ConfirmationBinding,
): boolean {
  return record.tenant_id === binding.tenant_id &&
    record.human_actor_id === binding.human_actor_id &&
    record.capability_id === binding.capability_id &&
    record.document_token === binding.document_token &&
    record.normalized_input_digest === binding.normalized_input_digest;
}

export class MemoryConfirmationStore implements ConfirmationStore {
  private readonly records = new Map<string, ConfirmationRecord>();

  async put(record: ConfirmationRecord): Promise<void> {
    if (this.records.has(record.challenge_id)) {
      throw new Error("confirmation challenge already exists");
    }
    this.records.set(record.challenge_id, clone(record));
  }

  async findPending(
    tenantId: string,
    humanActorId: string,
    phrase: string,
  ): Promise<ConfirmationRecord | null> {
    return [...this.records.values()]
      .filter((record) =>
        record.tenant_id === tenantId &&
        record.human_actor_id === humanActorId &&
        record.phrase === phrase &&
        record.proof_reference === null &&
        record.consumed_at === null
      )
      .sort((left, right) => right.expires_at.localeCompare(left.expires_at))
      .map(clone)[0] ?? null;
  }

  async confirm(
    challengeId: string,
    proofReference: string,
    confirmedAt: string,
  ): Promise<boolean> {
    const record = this.records.get(challengeId);
    if (record === undefined || record.proof_reference !== null) return false;
    this.records.set(challengeId, {
      ...record,
      proof_reference: proofReference,
      confirmed_at: confirmedAt,
    });
    return true;
  }

  async consume(
    binding: ConfirmationBinding,
    proofReference: string,
    consumedAt: string,
  ): Promise<boolean> {
    const entry = [...this.records.entries()].find(([, record]) =>
      record.proof_reference === proofReference &&
      record.confirmed_at !== null &&
      record.consumed_at === null &&
      matches(record, binding)
    );
    if (entry === undefined) return false;
    this.records.set(entry[0], { ...entry[1], consumed_at: consumedAt });
    return true;
  }
}
