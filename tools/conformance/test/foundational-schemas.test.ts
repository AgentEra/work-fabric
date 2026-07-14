import type { ErrorObject } from "ajv";
import { beforeAll, describe, expect, it } from "vitest";

import { loadSchemaRegistry } from "../src/schema-registry.js";

const schemaRoot = "protocol/schemas/v1";
let registry: Awaited<ReturnType<typeof loadSchemaRegistry>>;

beforeAll(async () => {
  registry = await loadSchemaRegistry(schemaRoot);
});

function validate(schemaName: string, value: unknown): ErrorObject[] | null {
  const schemaId = `urn:work-fabric:schema:v1:${schemaName}`;
  const validator = registry.getSchema(schemaId);
  if (validator === undefined) {
    throw new Error(`Schema not registered: ${schemaId}`);
  }
  validator(value);
  return validator.errors ?? null;
}

describe("ActorRef", () => {
  it.each(["human", "agent", "system"])(
    "accepts the %s actor type",
    (actorType) => {
      expect(
        validate("actor-ref", {
          actor_id: "actor_01",
          actor_type: actorType,
          extensions: {},
        }),
      ).toBeNull();
    },
  );

  it("rejects actor types outside the v1 contract", () => {
    expect(
      validate("actor-ref", {
        actor_id: "actor_01",
        actor_type: "group",
        extensions: {},
      }),
    ).not.toBeNull();
  });

  it("rejects opaque identifiers longer than 128 characters", () => {
    expect(
      validate("actor-ref", {
        actor_id: "a".repeat(129),
        actor_type: "agent",
        extensions: {},
      }),
    ).not.toBeNull();
  });
});

describe("ContentPart", () => {
  it.each([
    {
      kind: "text",
      media_type: "text/plain",
      text: "Implement the approved contract.",
      language: "en",
    },
    {
      kind: "data",
      schema_ref: "urn:example:schema:build-request:v1",
      data: { target: "api-server" },
    },
    {
      kind: "resource",
      resource: {
        uri: "urn:git:repo:example:commit:abc123",
        media_type: "application/vnd.git.commit",
        version: "abc123",
        extensions: {},
      },
    },
  ])("accepts the $kind content variant", (part) => {
    expect(validate("content-part", part)).toBeNull();
  });

  it("rejects inline binary content", () => {
    expect(
      validate("content-part", {
        kind: "binary",
        media_type: "application/octet-stream",
        bytes: "AAEC",
      }),
    ).not.toBeNull();
  });
});

describe("ContextBundle", () => {
  const context = {
    context_id: "context_01",
    version: 3,
    created_at: "2026-07-13T07:50:00Z",
    summary: "Approved requirement and implementation constraints",
    items: [
      {
        kind: "text",
        media_type: "text/plain",
        text: "Only implement the approved scope.",
      },
    ],
    visibility_scope: {
      actor_ids: ["actor_agent_01"],
      endpoint_ids: [],
      expires_at: "2026-07-14T08:00:00Z",
    },
    digest: {
      algorithm: "sha-256",
      value: "base64url-digest",
    },
    extensions: {},
  };

  it("accepts an explicitly scoped context bundle", () => {
    expect(validate("context-bundle", context)).toBeNull();
  });

  it("rejects a context bundle without visibility scope", () => {
    const { visibility_scope: _omitted, ...unscoped } = context;
    expect(validate("context-bundle", unscoped)).not.toBeNull();
  });
});

describe("AuthorityScope", () => {
  it("accepts a bounded delegation scope", () => {
    expect(
      validate("authority-scope", {
        delegation_id: "dlg_01",
        scopes: ["work:read", "artifact:write"],
        resource_refs: ["urn:work:project:42"],
        expires_at: "2026-07-14T08:00:00Z",
        may_redelegate: false,
        extensions: {},
      }),
    ).toBeNull();
  });

  it("rejects credentials in the authority object", () => {
    expect(
      validate("authority-scope", {
        delegation_id: "dlg_01",
        scopes: ["work:read"],
        resource_refs: ["urn:work:project:42"],
        expires_at: "2026-07-14T08:00:00Z",
        may_redelegate: false,
        access_token: "must-not-cross-the-protocol-boundary",
        extensions: {},
      }),
    ).not.toBeNull();
  });

  it("rejects credential-like extension keys", () => {
    expect(
      validate("authority-scope", {
        delegation_id: "dlg_01",
        scopes: ["work:read"],
        resource_refs: ["urn:work:project:42"],
        expires_at: "2026-07-14T08:00:00Z",
        may_redelegate: false,
        extensions: { "com.example/access_token": "secret" },
      }),
    ).not.toBeNull();
  });
});
