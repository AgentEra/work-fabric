import { describe, expect, it } from "vitest";

type Binding = {
  readonly tenant_id: string;
  readonly alias: string;
  readonly resource_uri: string;
  readonly external_calendar_id: string;
  readonly calendar_type: "primary" | "shared";
  readonly access_role: "writer" | "owner";
  readonly is_default: boolean;
  readonly active: boolean;
  readonly bound_by_principal_id: string;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
};

export type CalendarStore = {
  bind(input: Omit<Binding, "version">, expectedVersion: number):
    Promise<Binding>;
  getBinding(tenantId: string, alias: string): Promise<Binding | null>;
  getBindingByResource(
    tenantId: string,
    resourceUri: string,
  ): Promise<Binding | null>;
  getDefault(tenantId: string): Promise<Binding | null>;
  listBindings(input: {
    readonly tenant_id: string;
    readonly after_alias?: string;
    readonly limit: number;
  }): Promise<{
    readonly items: readonly Binding[];
    readonly next_after_alias: string | null;
  }>;
  setDefault(input: {
    readonly tenant_id: string;
    readonly alias: string;
    readonly expected_version: number;
    readonly updated_at: string;
  }): Promise<Binding>;
  beginExecution(input: {
    readonly tenant_id: string;
    readonly idempotency_key: string;
    readonly capability_id: string;
    readonly input_digest: `sha256:${string}`;
    readonly created_at: string;
  }): Promise<{
    readonly created: boolean;
    readonly record: {
      readonly state: string;
      readonly version: number;
      readonly event_resource_uri: string | null;
      readonly outcome: Record<string, unknown> | null;
    };
  }>;
  checkpoint(input: {
    readonly tenant_id: string;
    readonly idempotency_key: string;
    readonly expected_version: number;
    readonly state: string;
    readonly event_resource_uri?: string;
    readonly outcome?: Record<string, unknown>;
    readonly updated_at: string;
  }): Promise<{
    readonly state: string;
    readonly version: number;
    readonly event_resource_uri: string | null;
    readonly outcome: Record<string, unknown> | null;
  }>;
  getExecution(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<Record<string, unknown> | null>;
  putEventOwnership(input: {
    readonly tenant_id: string;
    readonly event_resource_uri: string;
    readonly calendar_resource_uri: string;
    readonly external_event_id: string;
    readonly citizen_id: string;
    readonly endpoint_id: string;
    readonly original_handoff_id: string;
    readonly initiating_actor_id: string;
    readonly create_idempotency_key: string;
    readonly provider_version: number;
    readonly external_updated_at: string | null;
    readonly deleted_at: string | null;
  }): Promise<void>;
  getEventOwnership(
    tenantId: string,
    eventResourceUri: string,
  ): Promise<Record<string, unknown> | null>;
  getEventOwnershipByCreateKey(
    tenantId: string,
    createIdempotencyKey: string,
  ): Promise<Record<string, unknown> | null>;
  updateEventVersion(input: {
    readonly tenant_id: string;
    readonly event_resource_uri: string;
    readonly expected_version: number;
    readonly external_updated_at: string | null;
  }): Promise<Record<string, unknown>>;
  markEventDeleted(input: {
    readonly tenant_id: string;
    readonly event_resource_uri: string;
    readonly expected_version: number;
    readonly deleted_at: string;
  }): Promise<Record<string, unknown>>;
  close(): Promise<void>;
};

const now = "2026-07-29T12:00:00.000Z";
const digestA = `sha256:${"a".repeat(64)}` as const;
const digestB = `sha256:${"b".repeat(64)}` as const;

function binding(
  overrides: Partial<Omit<Binding, "version">> = {},
): Omit<Binding, "version"> {
  return {
    tenant_id: "tenant-1",
    alias: "team",
    resource_uri: "feishu://calendar/cal-team",
    external_calendar_id: "cal-team",
    calendar_type: "shared",
    access_role: "owner",
    is_default: false,
    active: true,
    bound_by_principal_id: "principal-operator-1",
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function execution() {
  return {
    tenant_id: "tenant-1",
    idempotency_key: "idem-1",
    capability_id: "feishu.calendar.event.create",
    input_digest: digestA,
    created_at: now,
  };
}

function ownership() {
  return {
    tenant_id: "tenant-1",
    event_resource_uri: "feishu://calendar/cal-team/events/event-1",
    calendar_resource_uri: "feishu://calendar/cal-team",
    external_event_id: "event-1",
    citizen_id: "citizen-feishu-calendar",
    endpoint_id: "endpoint-feishu-provider",
    original_handoff_id: "handoff-1",
    initiating_actor_id: "actor-human-1",
    create_idempotency_key: "idem-1",
    provider_version: 1,
    external_updated_at: now,
    deleted_at: null,
  };
}

export function calendarStoreContract(
  name: string,
  create: () => Promise<CalendarStore>,
): void {
  describe(`${name} Feishu Calendar store contract`, () => {
    it("isolates tenants and paginates aliases deterministically", async () => {
      const store = await create();
      try {
        const first = await store.bind(binding({
          alias: "zeta",
          resource_uri: "feishu://calendar/cal-zeta",
          external_calendar_id: "cal-zeta",
        }), 0);
        await store.bind(binding({
          alias: "alpha",
          resource_uri: "feishu://calendar/cal-alpha",
          external_calendar_id: "cal-alpha",
        }), 0);
        await store.bind(binding({
          tenant_id: "tenant-2",
          alias: "alpha",
          resource_uri: "feishu://calendar/cal-other",
          external_calendar_id: "cal-other",
        }), 0);

        expect(first.version).toBe(1);
        await expect(store.listBindings({
          tenant_id: "tenant-1",
          limit: 1,
        })).resolves.toMatchObject({
          items: [{ alias: "alpha" }],
          next_after_alias: "alpha",
        });
        await expect(store.listBindings({
          tenant_id: "tenant-1",
          after_alias: "alpha",
          limit: 10,
        })).resolves.toMatchObject({
          items: [{ alias: "zeta" }],
          next_after_alias: null,
        });
        await expect(store.getBinding(
          "tenant-1",
          "alpha",
        )).resolves.toMatchObject({
          external_calendar_id: "cal-alpha",
        });
        await expect(store.getBindingByResource(
          "tenant-1",
          "feishu://calendar/cal-alpha",
        )).resolves.toMatchObject({
          alias: "alpha",
        });
        await expect(store.getBinding(
          "tenant-1",
          "missing",
        )).resolves.toBeNull();
      } finally {
        await store.close();
      }
    });

    it("enforces binding CAS and exactly one default per tenant", async () => {
      const store = await create();
      try {
        const team = await store.bind(binding({
          is_default: true,
        }), 0);
        await expect(store.bind(binding(), 0)).rejects.toThrow(
          "calendar_binding_version_conflict",
        );
        expect(await store.getDefault("tenant-1")).toEqual(team);
        const other = await store.bind(binding({
          alias: "other",
          resource_uri: "feishu://calendar/cal-other",
          external_calendar_id: "cal-other",
        }), 0);
        const selected = await store.setDefault({
          tenant_id: "tenant-1",
          alias: "other",
          expected_version: other.version,
          updated_at: "2026-07-29T12:01:00.000Z",
        });

        expect(selected).toMatchObject({
          alias: "other",
          is_default: true,
          version: 2,
        });
        await expect(store.getBinding(
          "tenant-1",
          "team",
        )).resolves.toMatchObject({
          is_default: false,
          version: 2,
        });
        await expect(store.setDefault({
          tenant_id: "tenant-1",
          alias: "other",
          expected_version: other.version,
          updated_at: "2026-07-29T12:02:00.000Z",
        })).rejects.toThrow("calendar_binding_version_conflict");
      } finally {
        await store.close();
      }
    });

    it("serializes concurrent default and execution creation races", async () => {
      const store = await create();
      try {
        const first = await store.bind(binding({
          alias: "first",
          resource_uri: "feishu://calendar/cal-first",
          external_calendar_id: "cal-first",
        }), 0);
        const second = await store.bind(binding({
          alias: "second",
          resource_uri: "feishu://calendar/cal-second",
          external_calendar_id: "cal-second",
        }), 0);
        const defaults = await Promise.allSettled([
          store.setDefault({
            tenant_id: "tenant-1",
            alias: "first",
            expected_version: first.version,
            updated_at: "2026-07-29T12:01:00.000Z",
          }),
          store.setDefault({
            tenant_id: "tenant-1",
            alias: "second",
            expected_version: second.version,
            updated_at: "2026-07-29T12:01:00.000Z",
          }),
        ]);
        expect(defaults.filter((result) =>
          result.status === "fulfilled"
        )).toHaveLength(2);
        expect(await store.getDefault("tenant-1")).toMatchObject({
          is_default: true,
        });
        const executions = await Promise.all([
          store.beginExecution(execution()),
          store.beginExecution(execution()),
        ]);
        expect(executions.map((result) => result.created).sort()).toEqual([
          false,
          true,
        ]);
      } finally {
        await store.close();
      }
    });

    it("fences executions by digest and checkpoint version", async () => {
      const store = await create();
      try {
        const begun = await store.beginExecution(execution());
        expect(begun).toMatchObject({
          created: true,
          record: {
            state: "started",
            version: 1,
            event_resource_uri: null,
            outcome: null,
          },
        });
        await expect(store.beginExecution(execution())).resolves.toMatchObject({
          created: false,
          record: { version: 1 },
        });
        await expect(store.beginExecution({
          ...execution(),
          input_digest: digestB,
        })).rejects.toThrow("calendar_execution_idempotency_conflict");
        const eventCreated = await store.checkpoint({
          tenant_id: "tenant-1",
          idempotency_key: "idem-1",
          expected_version: begun.record.version,
          state: "event_created",
          event_resource_uri: "feishu://calendar/cal-team/events/event-1",
          updated_at: "2026-07-29T12:01:00.000Z",
        });
        expect(eventCreated).toMatchObject({
          state: "event_created",
          version: 2,
          event_resource_uri:
            "feishu://calendar/cal-team/events/event-1",
        });
        await expect(store.checkpoint({
          tenant_id: "tenant-1",
          idempotency_key: "idem-1",
          expected_version: 1,
          state: "completed",
          outcome: { outcome: "succeeded" },
          updated_at: "2026-07-29T12:02:00.000Z",
        })).rejects.toThrow("calendar_execution_version_conflict");
        await expect(store.getExecution(
          "tenant-2",
          "idem-1",
        )).resolves.toBeNull();
      } finally {
        await store.close();
      }
    });

    it("replays ownership idempotently and preserves versioned tombstones", async () => {
      const store = await create();
      try {
        await store.putEventOwnership(ownership());
        await store.putEventOwnership(ownership());
        await expect(store.putEventOwnership({
          ...ownership(),
          create_idempotency_key: "idem-other",
        })).rejects.toThrow("calendar_event_ownership_conflict");
        await expect(store.getEventOwnershipByCreateKey(
          "tenant-1",
          "idem-1",
        )).resolves.toMatchObject({
          event_resource_uri:
            "feishu://calendar/cal-team/events/event-1",
        });
        const updated = await store.updateEventVersion({
          tenant_id: "tenant-1",
          event_resource_uri:
            "feishu://calendar/cal-team/events/event-1",
          expected_version: 1,
          external_updated_at: "2026-07-29T12:03:00.000Z",
        });
        expect(updated).toMatchObject({
          provider_version: 2,
          external_updated_at: "2026-07-29T12:03:00.000Z",
        });
        const deleted = await store.markEventDeleted({
          tenant_id: "tenant-1",
          event_resource_uri:
            "feishu://calendar/cal-team/events/event-1",
          expected_version: 2,
          deleted_at: "2026-07-29T12:04:00.000Z",
        });
        expect(deleted).toMatchObject({
          provider_version: 3,
          deleted_at: "2026-07-29T12:04:00.000Z",
        });
        await expect(store.markEventDeleted({
          tenant_id: "tenant-1",
          event_resource_uri:
            "feishu://calendar/cal-team/events/event-1",
          expected_version: 3,
          deleted_at: "2026-07-29T12:04:00.000Z",
        })).resolves.toEqual(deleted);
        await expect(store.getEventOwnership(
          "tenant-2",
          "feishu://calendar/cal-team/events/event-1",
        )).resolves.toBeNull();
      } finally {
        await store.close();
      }
    });
  });
}
