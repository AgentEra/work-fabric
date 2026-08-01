import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import * as provider from "../src/index.js";
import {
  calendarStoreContract,
  type CalendarStore,
} from "./calendar-store-contract.js";

type Constructor = new (options: {
  readonly location: string;
  readonly busy_timeout_ms?: number;
}) => CalendarStore;

function constructor(): Constructor | undefined {
  const value = (provider as Record<string, unknown>)[
    "SqliteFeishuCalendarStore"
  ];
  return typeof value === "function" ? value as Constructor : undefined;
}

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("SqliteFeishuCalendarStore", () => {
  it("is exposed as a separate restart-safe Calendar state adapter", () => {
    expect(constructor()).toBeTypeOf("function");
  });

  it("preserves bindings, execution checkpoints and ownership after restart", async () => {
    const Constructor = constructor();
    if (Constructor === undefined) return;
    const directory = await mkdtemp(join(tmpdir(), "wf-calendar-store-"));
    directories.push(directory);
    const location = join(directory, "calendar.db");
    const first = new Constructor({ location });
    await first.bind({
      tenant_id: "tenant-1",
      alias: "team",
      resource_uri: "feishu://calendar/cal-team",
      external_calendar_id: "cal-team",
      calendar_type: "shared",
      access_role: "owner",
      is_default: true,
      active: true,
      bound_by_principal_id: "principal-operator-1",
      created_at: "2026-07-29T12:00:00.000Z",
      updated_at: "2026-07-29T12:00:00.000Z",
    }, 0);
    const begun = await first.beginExecution({
      tenant_id: "tenant-1",
      idempotency_key: "idem-1",
      capability_id: "feishu.calendar.event.create",
      input_digest: `sha256:${"a".repeat(64)}`,
      created_at: "2026-07-29T12:00:00.000Z",
    });
    await first.checkpoint({
      tenant_id: "tenant-1",
      idempotency_key: "idem-1",
      expected_version: begun.record.version,
      state: "event_created",
      event_resource_uri: "feishu://calendar/cal-team/events/event-1",
      updated_at: "2026-07-29T12:01:00.000Z",
    });
    await first.putEventOwnership({
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
      external_updated_at: "2026-07-29T12:01:00.000Z",
      deleted_at: null,
    });
    await first.close();

    const reopened = new Constructor({ location });
    await expect(reopened.getDefault("tenant-1")).resolves.toMatchObject({
      alias: "team",
    });
    await expect(reopened.getExecution(
      "tenant-1",
      "idem-1",
    )).resolves.toMatchObject({
      state: "event_created",
      version: 2,
    });
    await expect(reopened.getEventOwnership(
      "tenant-1",
      "feishu://calendar/cal-team/events/event-1",
    )).resolves.toMatchObject({
      external_event_id: "event-1",
    });
    await reopened.close();
  });

  it("rejects a stored binding whose indexed identity disagrees with its JSON record", async () => {
    const Constructor = constructor();
    if (Constructor === undefined) return;
    const directory = await mkdtemp(join(tmpdir(), "wf-calendar-store-"));
    directories.push(directory);
    const location = join(directory, "calendar.db");
    const store = new Constructor({ location });
    await store.bind({
      tenant_id: "tenant-1",
      alias: "team",
      resource_uri: "feishu://calendar/cal-team",
      external_calendar_id: "cal-team",
      calendar_type: "shared",
      access_role: "owner",
      is_default: true,
      active: true,
      bound_by_principal_id: "principal-operator-1",
      created_at: "2026-07-29T12:00:00.000Z",
      updated_at: "2026-07-29T12:00:00.000Z",
    }, 0);
    await store.close();
    const database = new DatabaseSync(location);
    database.prepare(`
      UPDATE feishu_calendar_bindings
      SET record_json = json_set(record_json, '$.alias', 'tampered')
      WHERE tenant_id = 'tenant-1' AND alias = 'team'
    `).run();
    database.close();

    const reopened = new Constructor({ location });
    await expect(reopened.getBinding(
      "tenant-1",
      "team",
    )).rejects.toThrow("calendar_record_incompatible");
    await reopened.close();
  });
});

calendarStoreContract("sqlite", async () => {
  const Constructor = constructor();
  if (Constructor === undefined) {
    throw new TypeError("SqliteFeishuCalendarStore is unavailable");
  }
  return new Constructor({ location: ":memory:" });
});
