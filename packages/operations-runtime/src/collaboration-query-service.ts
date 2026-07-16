import type {
  CollaborationPage,
  CollaborationViewStore,
  ProjectionFreshness,
  ProjectionFreshnessSource,
  RelationshipQuery,
  RelationshipView,
  ResponsibilityQuery,
  ResponsibilityView,
  TimelineEntry,
  TimelineQuery,
} from "@work-fabric/operations-spi";

export type ResponsibilityQueryInput = Omit<ResponsibilityQuery, "tenant_id">;
export type TimelineQueryInput = Omit<TimelineQuery, "tenant_id">;
export type RelationshipQueryInput = Omit<RelationshipQuery, "tenant_id">;

export interface CollaborationQueryService {
  listResponsibilities(
    tenantId: string,
    input: ResponsibilityQueryInput,
  ): Promise<CollaborationPage<ResponsibilityView>>;
  listTimeline(
    tenantId: string,
    input: TimelineQueryInput,
  ): Promise<CollaborationPage<TimelineEntry>>;
  listRelationships(
    tenantId: string,
    input: RelationshipQueryInput,
  ): Promise<CollaborationPage<RelationshipView>>;
}

function safeFreshness(
  input: ProjectionFreshness,
  partitionId: string,
): ProjectionFreshness {
  if (
    input.partition_id !== partitionId ||
    typeof input.projector_id !== "string" ||
    input.projector_id.length === 0 ||
    !Number.isSafeInteger(input.projected_position) ||
    input.projected_position < 0 ||
    !Number.isSafeInteger(input.journal_position) ||
    input.journal_position < input.projected_position ||
    !Number.isFinite(Date.parse(input.observed_at))
  ) throw new Error("projection freshness is invalid");
  return structuredClone(input);
}

export class StoreBackedCollaborationQueryService
  implements CollaborationQueryService
{
  constructor(
    private readonly store: CollaborationViewStore,
    private readonly freshness: ProjectionFreshnessSource,
  ) {}

  async listResponsibilities(
    tenantId: string,
    input: ResponsibilityQueryInput,
  ): Promise<CollaborationPage<ResponsibilityView>> {
    const [page, freshness] = await Promise.all([
      this.store.listResponsibilities({ ...input, tenant_id: tenantId }),
      this.freshness.load(tenantId, input.partition_id),
    ]);
    const safe = page.items.every(
      (item) =>
        item.tenant_id === tenantId && item.partition_id === input.partition_id,
    );
    return {
      items: safe ? structuredClone(page.items) : [],
      next_cursor: safe ? page.next_cursor : null,
      freshness: safeFreshness(freshness, input.partition_id),
    };
  }

  async listTimeline(
    tenantId: string,
    input: TimelineQueryInput,
  ): Promise<CollaborationPage<TimelineEntry>> {
    const [page, freshness] = await Promise.all([
      this.store.listTimeline({ ...input, tenant_id: tenantId }),
      this.freshness.load(tenantId, input.partition_id),
    ]);
    const safe = page.items.every(
      (item) =>
        item.tenant_id === tenantId && item.partition_id === input.partition_id,
    );
    return {
      items: safe ? structuredClone(page.items) : [],
      next_cursor: safe ? page.next_cursor : null,
      freshness: safeFreshness(freshness, input.partition_id),
    };
  }

  async listRelationships(
    tenantId: string,
    input: RelationshipQueryInput,
  ): Promise<CollaborationPage<RelationshipView>> {
    const [page, freshness] = await Promise.all([
      this.store.listRelationships({ ...input, tenant_id: tenantId }),
      this.freshness.load(tenantId, input.partition_id),
    ]);
    const safe = page.items.every(
      (item) =>
        item.tenant_id === tenantId && item.partition_id === input.partition_id,
    );
    return {
      items: safe ? structuredClone(page.items) : [],
      next_cursor: safe ? page.next_cursor : null,
      freshness: safeFreshness(freshness, input.partition_id),
    };
  }
}
