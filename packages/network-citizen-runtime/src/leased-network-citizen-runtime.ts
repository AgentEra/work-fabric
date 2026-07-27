import {
  canonicalCitizenDigest,
  validateCitizenDeclarations,
  validateNetworkCitizenDescriptor,
  type CitizenDeclaration,
  type CitizenHealth,
  type CitizenRuntimeContext,
  type NetworkCitizenDescriptor,
  type NetworkCitizenRuntime,
  type PublicCitizenSession,
} from "@work-fabric/network-citizen-spi";

export interface LeasedNetworkCitizenRuntimeOptions {
  readonly citizen_id: string;
  readonly client_session_id: string;
  readonly expected_registration_version: number;
}

function stableDescriptorDigest(
  descriptor: NetworkCitizenDescriptor,
): `sha256:${string}` {
  const {
    availability: _availability,
    declarations: _declarations,
    ...stable
  } = descriptor;
  return canonicalCitizenDigest(stable);
}

function delayUntil(
  now: string,
  renewAfter: string,
  expiresAt: string,
  safetyMarginMs: number,
): number {
  const nowMs = Date.parse(now);
  const renewMs = Date.parse(renewAfter);
  const expiresMs = Date.parse(expiresAt);
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(renewMs) ||
    !Number.isFinite(expiresMs)
  ) {
    throw new TypeError("Citizen lease timestamps are invalid");
  }
  return Math.max(0, Math.min(renewMs, expiresMs - safetyMarginMs) - nowMs);
}

export abstract class LeasedNetworkCitizenRuntime
  implements NetworkCitizenRuntime {
  abstract readonly citizen_kind: NetworkCitizenRuntime["citizen_kind"];

  private context: CitizenRuntimeContext | null = null;
  private session: PublicCitizenSession | null = null;
  private timer: unknown = null;
  private mutationTail: Promise<void> = Promise.resolve();
  private closing: Promise<void> | null = null;
  private stableDescriptor: `sha256:${string}` | null = null;
  private healthValue: CitizenHealth = {
    status: "starting",
    session_id: null,
    fencing_token: null,
    declaration_version: null,
    checked_at: new Date(0).toISOString(),
  };

  protected constructor(
    private readonly options: LeasedNetworkCitizenRuntimeOptions,
  ) {
    if (
      options.citizen_id.length === 0 ||
      options.client_session_id.length === 0 ||
      !Number.isSafeInteger(options.expected_registration_version) ||
      options.expected_registration_version < 1
    ) {
      throw new TypeError("Leased Network Citizen options are invalid");
    }
  }

  protected abstract currentDescriptor(): NetworkCitizenDescriptor;

  protected abstract currentDeclarations(): readonly CitizenDeclaration[];

  async start(context: CitizenRuntimeContext): Promise<void> {
    if (this.context !== null || this.session !== null) {
      throw new Error("Network Citizen Runtime is already started");
    }
    if (context.signal.aborted) {
      throw new Error("Network Citizen Runtime start was aborted");
    }
    this.context = context;
    this.healthValue = this.healthState("starting");
    let opened: PublicCitizenSession | null = null;
    try {
      const descriptor = validateNetworkCitizenDescriptor(
        this.currentDescriptor(),
      );
      const declarations = validateCitizenDeclarations(
        this.currentDeclarations(),
      );
      this.assertDeclarationDigest(descriptor, declarations);
      if (
        descriptor.citizen_id !== this.options.citizen_id ||
        descriptor.citizen_kind !== this.citizen_kind
      ) {
        throw new TypeError("Runtime descriptor does not match its Citizen identity");
      }
      opened = await context.client.openSession(this.options.citizen_id, {
        client_session_id: this.options.client_session_id,
        descriptor,
        declarations,
        requested_lease_seconds: context.requested_lease_seconds,
        expected_registration_version:
          this.options.expected_registration_version,
      });
      this.session = opened;
      this.stableDescriptor = stableDescriptorDigest(descriptor);
      this.healthValue = this.healthState(this.availableHealth(opened));
      this.schedule(opened);
    } catch (error) {
      this.clearTimer();
      if (opened !== null) {
        await context.client
          .closeSession(this.options.citizen_id, opened.session_id, {
            fencing_token: opened.fencing_token,
            heartbeat_sequence: opened.heartbeat_sequence + 1,
            expected_registration_version:
              this.options.expected_registration_version,
          })
          .catch(() => undefined);
      }
      this.session = null;
      this.healthValue = this.healthState("unavailable", "start_failed");
      throw error;
    }
  }

  async replaceDeclarations(
    input: readonly CitizenDeclaration[],
  ): Promise<void> {
    await this.enqueue(async () => {
      const context = this.requireContext();
      const session = this.requireSession();
      const declarations = validateCitizenDeclarations(input);
      const current = validateCitizenDeclarations(this.currentDeclarations());
      if (
        canonicalCitizenDigest(current) !== canonicalCitizenDigest(declarations)
      ) {
        throw new Error("Runtime declaration source differs from replacement");
      }
      const descriptor = validateNetworkCitizenDescriptor(
        this.currentDescriptor(),
      );
      this.assertDeclarationDigest(descriptor, declarations);
      if (stableDescriptorDigest(descriptor) !== this.stableDescriptor) {
        throw new Error("Runtime descriptor drift requires a new session");
      }
      const replaced = await context.client.replaceDeclarations(
        this.options.citizen_id,
        session.session_id,
        {
          fencing_token: session.fencing_token,
          expected_registration_version:
            this.options.expected_registration_version,
          expected_declaration_version: session.declaration_version,
          declarations,
        },
      );
      this.session = replaced;
      this.healthValue = this.healthState(this.availableHealth(replaced));
    });
  }

  async health(): Promise<CitizenHealth> {
    return structuredClone(this.healthValue);
  }

  async close(): Promise<void> {
    if (this.closing !== null) return this.closing;
    this.closing = (async () => {
      this.clearTimer();
      await this.mutationTail;
      const context = this.context;
      const session = this.session;
      if (context !== null && session !== null && session.state === "active") {
        await context.client.closeSession(
          this.options.citizen_id,
          session.session_id,
          {
            fencing_token: session.fencing_token,
            heartbeat_sequence: session.heartbeat_sequence + 1,
            expected_registration_version:
              this.options.expected_registration_version,
          },
        );
      }
      this.session = null;
      this.healthValue = this.healthState("closed");
    })();
    return this.closing;
  }

  private async heartbeat(): Promise<void> {
    const context = this.requireContext();
    const session = this.requireSession();
    const descriptor = validateNetworkCitizenDescriptor(
      this.currentDescriptor(),
    );
    const declarations = validateCitizenDeclarations(
      this.currentDeclarations(),
    );
    if (
      stableDescriptorDigest(descriptor) !== this.stableDescriptor ||
      canonicalCitizenDigest(declarations) !== session.declaration_digest ||
      descriptor.declarations.count !== declarations.length ||
      descriptor.declarations.digest !== session.declaration_digest
    ) {
      this.healthValue = this.healthState(
        "unavailable",
        "descriptor_drift",
      );
      return;
    }
    try {
      const renewed = await context.client.heartbeat(
        this.options.citizen_id,
        session.session_id,
        {
          fencing_token: session.fencing_token,
          heartbeat_sequence: session.heartbeat_sequence + 1,
          availability: descriptor.availability,
          expected_registration_version:
            this.options.expected_registration_version,
        },
      );
      this.session = renewed;
      this.healthValue = this.healthState(this.availableHealth(renewed));
      this.schedule(renewed);
    } catch {
      this.healthValue = this.healthState("unavailable", "lease_lost");
    }
  }

  private schedule(session: PublicCitizenSession): void {
    const context = this.requireContext();
    this.clearTimer();
    const delay = delayUntil(
      context.clock.now(),
      session.renew_after,
      session.expires_at,
      context.heartbeat_safety_margin_ms,
    );
    this.timer = context.clock.setTimeout(() => {
      this.timer = null;
      void this.enqueue(() => this.heartbeat());
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer !== null && this.context !== null) {
      this.context.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private assertDeclarationDigest(
    descriptor: NetworkCitizenDescriptor,
    declarations: readonly CitizenDeclaration[],
  ): void {
    const digest = canonicalCitizenDigest(declarations);
    if (
      descriptor.declarations.count !== declarations.length ||
      descriptor.declarations.digest !== digest
    ) {
      throw new TypeError("Runtime descriptor declaration digest is invalid");
    }
  }

  private availableHealth(
    session: PublicCitizenSession,
  ): "available" | "degraded" | "unavailable" {
    if (session.descriptor.availability === "degraded") return "degraded";
    if (
      session.descriptor.availability === "available" ||
      session.descriptor.availability === "draining"
    ) {
      return "available";
    }
    return "unavailable";
  }

  private healthState(
    status: CitizenHealth["status"],
    detailCode?: string,
  ): CitizenHealth {
    const now = this.context?.clock.now() ?? new Date(0).toISOString();
    return {
      status,
      session_id: this.session?.session_id ?? null,
      fencing_token: this.session?.fencing_token ?? null,
      declaration_version: this.session?.declaration_version ?? null,
      checked_at: now,
      ...(detailCode === undefined ? {} : { detail_code: detailCode }),
    };
  }

  private requireContext(): CitizenRuntimeContext {
    if (this.context === null) {
      throw new Error("Network Citizen Runtime is not started");
    }
    return this.context;
  }

  private requireSession(): PublicCitizenSession {
    if (this.session === null || this.session.state !== "active") {
      throw new Error("Network Citizen Runtime has no active session");
    }
    return this.session;
  }
}
