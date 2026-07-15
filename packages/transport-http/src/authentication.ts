import type { JsonObject } from "@work-fabric/exchange-spi";

import type {
  HttpAuthenticationMetadata,
  HttpRequestAuthenticator,
} from "./public-types.js";

export class BearerAuthenticationEvidenceMapper
  implements HttpRequestAuthenticator
{
  async authenticationEvidence(
    metadata: HttpAuthenticationMetadata,
  ): Promise<JsonObject | null> {
    const authorization = metadata.authorization;
    if (authorization === null) return null;
    const match = /^Bearer ([^\s]+)$/.exec(authorization);
    return match?.[1] === undefined ? null : { bearer_token: match[1] };
  }
}
