import type {
  AuthorityPolicy,
  ContextRepository,
  ExchangePersistence,
  IdentityProvider,
  ResolvedPrincipal,
} from "@work-fabric/exchange-spi";
import type { WfppCommandValidator } from "@work-fabric/protocol-runtime";

import type { ActorRef } from "../domain/handoff-types.js";

export interface Clock {
  now(): string;
}

export interface IdGenerator {
  nextId(kind: "handoff" | "event" | "commit" | "receipt" | "delivery"): string;
}

export interface AuthenticatedCommandContext {
  readonly principal: ResolvedPrincipal;
  readonly actor: ActorRef;
}

export interface ExchangeApplicationDependencies {
  readonly persistence: ExchangePersistence;
  readonly identity: IdentityProvider;
  readonly authority: AuthorityPolicy;
  readonly context: ContextRepository;
  readonly validator: WfppCommandValidator;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}
