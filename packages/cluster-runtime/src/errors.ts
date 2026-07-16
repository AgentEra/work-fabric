export type ClusterErrorCode =
  | "partition_lease_lost"
  | "partition_turn_failed";

export class ClusterError extends Error {
  override readonly name = "ClusterError";

  constructor(readonly code: ClusterErrorCode) {
    super(code);
  }
}
