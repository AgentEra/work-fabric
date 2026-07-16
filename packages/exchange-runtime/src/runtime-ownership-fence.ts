/** A structural, technology-neutral guard supplied by an owning runtime. */
export interface RuntimeOwnershipFence {
  assertOwnership(): Promise<void>;
}
