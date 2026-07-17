import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyChannelRouteStoreProfile } from "@work-fabric/exchange-conformance";
import { SqliteChannelRouteStore, SqliteSession, migrateSqlite } from "../src/index.js";

describe("SqliteChannelRouteStore", () => {
  it("passes the shared profile and persists across restart", async () => {
    const location = join(mkdtempSync(join(tmpdir(), "wf-route-")), "wf.db");
    const first = new SqliteSession({ location });
    migrateSqlite(first);
    await verifyChannelRouteStoreProfile(() => new SqliteChannelRouteStore(first));
    first.close();
    const second = new SqliteSession({ location });
    migrateSqlite(second);
    await expect(new SqliteChannelRouteStore(second).get({ tenant_id: "tenant_profile", plugin_instance_id: "channel_profile", handoff_id: "handoff_01" })).resolves.toMatchObject({ version: 2 });
    second.close();
  });
});
