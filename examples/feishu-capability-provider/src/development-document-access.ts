import {
  validateDocumentResourceReference,
  type DocumentAccessAuthorizer,
  type DocumentAccessDecision,
  type DocumentAccessRequest,
  type DocumentPlacementResolver,
} from "@work-fabric/document-provider-spi";
import {
  FeishuDocumentResourceAdapter,
} from "@work-fabric/provider-feishu";

const DEVELOPMENT_EVIDENCE_REF = "development:app-identity";
const MAX_DECISION_LIFETIME_MS = 5 * 60 * 1_000;

export interface ConfiguredDocumentAccess {
  readonly development_mode: boolean;
  readonly document_access:
    | { readonly mode: "brokered_native" }
    | {
        readonly mode: "development_app_identity";
        readonly default_resource_uri: string;
      };
}

export class DevelopmentAppIdentityDocumentAccessAuthorizer
implements DocumentAccessAuthorizer {
  private readonly now: () => string;

  constructor(options: { readonly now?: () => string } = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async authorize(
    input: DocumentAccessRequest,
    signal?: AbortSignal,
  ): Promise<DocumentAccessDecision> {
    signal?.throwIfAborted();
    const now = Date.parse(this.now());
    const delegationExpiry = Date.parse(input.expires_at);
    if (
      !Number.isFinite(now) ||
      !Number.isFinite(delegationExpiry) ||
      delegationExpiry <= now
    ) {
      return { decision: "deny", reason: "delegation_invalid" };
    }
    if (input.operation === "delete") {
      return { decision: "deny", reason: "permission_denied" };
    }
    const requiredScope = input.operation === "read"
      ? "document:read"
      : "document:write";
    if (!input.scopes.includes(requiredScope)) {
      return { decision: "deny", reason: "delegation_invalid" };
    }
    return {
      decision: "allow",
      evidence_ref: DEVELOPMENT_EVIDENCE_REF,
      valid_until: new Date(Math.min(
        delegationExpiry,
        now + MAX_DECISION_LIFETIME_MS,
      )).toISOString(),
    };
  }
}

function placementResolver(
  defaultResourceUri: string | null,
): DocumentPlacementResolver {
  const resources = new FeishuDocumentResourceAdapter();
  const defaultReference = defaultResourceUri === null
    ? null
    : validateDocumentResourceReference({
        resource_uri: defaultResourceUri,
      });
  if (
    defaultReference !== null &&
    resources.resolve(defaultReference).kind !== "container"
  ) {
    throw new TypeError(
      "service.document_access.default_resource_uri must reference a Feishu container",
    );
  }
  return {
    async resolve(input) {
      if (input.placement === null) {
        if (defaultReference !== null) return defaultReference;
        throw new Error("Document placement resolver is unavailable");
      }
      if ("resource_uri" in input.placement) {
        return validateDocumentResourceReference(input.placement);
      }
      throw new Error("Document placement policy resolver is unavailable");
    },
  };
}

export function createConfiguredDocumentServices(
  config: ConfiguredDocumentAccess,
  environment: Readonly<Record<string, string | undefined>>,
): {
  readonly document_access: DocumentAccessAuthorizer;
  readonly placement: DocumentPlacementResolver;
} {
  if (config.document_access.mode === "development_app_identity") {
    if (!config.development_mode) {
      throw new TypeError(
        "development_app_identity requires service.development_mode",
      );
    }
    if (
      environment.WORK_FABRIC_ALLOW_UNSAFE_DOCUMENT_ACCESS !== "true"
    ) {
      throw new TypeError(
        "WORK_FABRIC_ALLOW_UNSAFE_DOCUMENT_ACCESS=true is required",
      );
    }
    return {
      document_access:
        new DevelopmentAppIdentityDocumentAccessAuthorizer(),
      placement: placementResolver(
        config.document_access.default_resource_uri,
      ),
    };
  }
  return {
    document_access: {
      async authorize() {
        return {
          decision: "deny",
          reason: "authorization_unavailable",
        };
      },
    },
    placement: placementResolver(null),
  };
}
