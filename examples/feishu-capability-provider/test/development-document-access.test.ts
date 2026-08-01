import { describe, expect, it } from "vitest";

import {
  createConfiguredDocumentServices,
  DevelopmentAppIdentityDocumentAccessAuthorizer,
} from "../src/development-document-access.js";

const accessRequest = {
  tenant_id: "tenant-local",
  represented_actor_id: "actor-human-1",
  delegation_id: "delegation-1",
  operation: "create" as const,
  resource: { resource_uri: "feishu://drive/root" },
  scopes: ["document:write"],
  expires_at: "2026-07-28T10:10:00.000Z",
};

describe("development document access", () => {
  it("allows non-destructive app-identity operations with bounded opaque evidence", async () => {
    const authorizer = new DevelopmentAppIdentityDocumentAccessAuthorizer({
      now: () => "2026-07-28T10:00:00.000Z",
    });

    const decision = await authorizer.authorize(accessRequest);

    expect(decision).toEqual({
      decision: "allow",
      evidence_ref: "development:app-identity",
      valid_until: "2026-07-28T10:05:00.000Z",
    });
    expect(JSON.stringify(decision)).not.toMatch(
      /actor-human|delegation-1|tenant-local|secret|token/i,
    );
  });

  it("denies expired delegations and destructive operations", async () => {
    const authorizer = new DevelopmentAppIdentityDocumentAccessAuthorizer({
      now: () => "2026-07-28T10:11:00.000Z",
    });
    await expect(authorizer.authorize(accessRequest)).resolves.toEqual({
      decision: "deny",
      reason: "delegation_invalid",
    });

    const active = new DevelopmentAppIdentityDocumentAccessAuthorizer({
      now: () => "2026-07-28T10:00:00.000Z",
    });
    await expect(active.authorize({
      ...accessRequest,
      operation: "delete",
    })).resolves.toEqual({
      decision: "deny",
      reason: "permission_denied",
    });
  });

  it("requires all development guards and keeps placement separate", async () => {
    expect(() => createConfiguredDocumentServices({
      development_mode: false,
      document_access: {
        mode: "development_app_identity",
        default_resource_uri: "feishu://drive/root",
      },
    }, {
      WORK_FABRIC_ALLOW_UNSAFE_DOCUMENT_ACCESS: "true",
    })).toThrow(/development_mode/i);

    expect(() => createConfiguredDocumentServices({
      development_mode: true,
      document_access: {
        mode: "development_app_identity",
        default_resource_uri: "feishu://drive/root",
      },
    }, {})).toThrow(/WORK_FABRIC_ALLOW_UNSAFE_DOCUMENT_ACCESS/);

    const services = createConfiguredDocumentServices({
      development_mode: true,
      document_access: {
        mode: "development_app_identity",
        default_resource_uri: "feishu://drive/folder/fld_default",
      },
    }, {
      WORK_FABRIC_ALLOW_UNSAFE_DOCUMENT_ACCESS: "true",
    });
    await expect(services.placement.resolve({
      tenant_id: "tenant-local",
      represented_actor_id: "actor-human-1",
      delegation_id: "delegation-1",
      placement: null,
    })).resolves.toEqual({
      resource_uri: "feishu://drive/folder/fld_default",
    });
    await expect(services.placement.resolve({
      tenant_id: "tenant-local",
      represented_actor_id: "actor-human-1",
      delegation_id: "delegation-1",
      placement: { resource_uri: "feishu://drive/folder/fld_explicit" },
    })).resolves.toEqual({
      resource_uri: "feishu://drive/folder/fld_explicit",
    });
    await expect(services.placement.resolve({
      tenant_id: "tenant-local",
      represented_actor_id: "actor-human-1",
      delegation_id: "delegation-1",
      placement: { policy_ref: "customer.project.default" },
    })).rejects.toThrow(/policy resolver/i);
  });

  it("keeps native mode fail-closed unless the composition injects an adapter", async () => {
    const services = createConfiguredDocumentServices({
      development_mode: false,
      document_access: {
        mode: "brokered_native",
      },
    }, {});

    await expect(services.document_access.authorize(accessRequest)).resolves
      .toEqual({
        decision: "deny",
        reason: "authorization_unavailable",
      });
    await expect(services.placement.resolve({
      tenant_id: "tenant-local",
      represented_actor_id: "actor-human-1",
      delegation_id: "delegation-1",
      placement: null,
    })).rejects.toThrow(/placement resolver/i);
  });
});
