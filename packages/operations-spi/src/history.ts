import type {
  DeadLetterRecord,
  DeliveryAttempt,
  ExchangeAdapter,
  ProjectionFailureRecord,
} from "@work-fabric/exchange-spi";

export interface ProjectionFailureKeyset {
  readonly position: number;
  readonly event_id: string;
}

export interface DeliveryAttemptKeyset {
  readonly attempt: number;
  readonly attempted_at: string;
}

export interface DeadLetterKeyset {
  readonly recorded_at: string;
  readonly event_id: string;
}

/**
 * Optional production read port for histories whose legacy Exchange SPI shape
 * returns a complete identity-scoped array. Results are already ordered and
 * must contain no more than `limit` records. Query Runtime still owns
 * redaction and opaque public cursors.
 */
export interface BoundedOperationalHistoryStore extends ExchangeAdapter {
  scanProjectionFailures(input: {
    readonly tenant_id: string;
    readonly projector_id: string;
    readonly partition_id: string;
    readonly after: ProjectionFailureKeyset | null;
    readonly limit: number;
  }): Promise<readonly ProjectionFailureRecord[]>;

  scanDeliveryAttempts(input: {
    readonly tenant_id: string;
    readonly subscription_id: string;
    readonly event_id: string;
    readonly after: DeliveryAttemptKeyset | null;
    readonly limit: number;
  }): Promise<readonly DeliveryAttempt[]>;

  scanDeadLetters(input: {
    readonly tenant_id: string;
    readonly subscription_id: string;
    readonly event_id?: string;
    readonly after: DeadLetterKeyset | null;
    readonly limit: number;
  }): Promise<readonly DeadLetterRecord[]>;
}
