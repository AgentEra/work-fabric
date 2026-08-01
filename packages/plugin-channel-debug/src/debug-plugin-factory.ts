import type { CollaborationAdmissionService } from "@work-fabric/admission-spi";
import type {
  ChannelHandoffSnapshotSource,
  ChannelRouteStore,
} from "@work-fabric/channel-spi";
import { ConnectorWorker } from "@work-fabric/connector-runtime";
import type {
  ConnectorCommandSink,
  ConnectorIngressStore,
  ConnectorObservationSink,
} from "@work-fabric/connector-spi";
import type { DebugChannelStore } from "@work-fabric/debug-channel-spi";
import type {
  SignalAdapter,
  SubscriptionStore,
} from "@work-fabric/exchange-spi";
import type { OpaqueCursorCodec } from "@work-fabric/operations-spi";
import type {
  PluginContext,
  PluginFactory,
  PluginHealth,
  PluginInstance,
  PluginInstanceConfiguration,
} from "@work-fabric/plugin-spi";

import {
  validateDebugPluginConfig,
  type DebugPluginConfig,
} from "./config.js";
import { DebugEventMapper } from "./event-mapper.js";
import {
  DebugChannelHttpServer,
  type DebugClock,
  type DebugIdSource,
} from "./http-server.js";
import { DebugIntakeReceiptHandler } from "./intake-receipt-handler.js";
import { ConfiguredDebugParticipantResolver } from "./participant-resolver.js";
import { DebugRouteAwareSignalAdapter } from "./signal-adapter.js";
import type { DebugHandoffSnapshotSource } from "./status-source.js";

export interface DebugChannelSignalRegistration {
  register(instanceId: string, adapter: SignalAdapter): void;
  unregister(instanceId: string): void;
}

function addSeconds(timestamp: string, seconds: number): string {
  return new Date(Date.parse(timestamp) + seconds * 1_000).toISOString();
}

function unavailableAdmission(): CollaborationAdmissionService {
  return {
    async admit() {
      throw new Error("collaboration admission is not configured");
    },
  };
}

function validAdmission(value: unknown): CollaborationAdmissionService {
  if (
    (typeof value !== "object" || value === null)
    && typeof value !== "function"
  ) {
    throw new TypeError("collaboration.admission capability is invalid");
  }
  const method = (value as { readonly admit?: unknown }).admit;
  if (typeof method !== "function") {
    throw new TypeError("collaboration.admission capability is invalid");
  }
  return {
    admit(policyId, request) {
      return Reflect.apply(method, value, [policyId, request]) as ReturnType<
        CollaborationAdmissionService["admit"]
      >;
    },
  };
}

function debugSnapshotSource(
  source: ChannelHandoffSnapshotSource,
): DebugHandoffSnapshotSource {
  return {
    async load(tenantId, handoffId) {
      const result = await source.get({
        tenant_id: tenantId,
        handoff_id: handoffId,
        minimum_resource_version: 1,
      });
      if (result.kind !== "ready") return null;
      const version = result.snapshot.resource_version;
      const lifecycleState = result.snapshot.lifecycle_state;
      return Number.isSafeInteger(version)
          && (version as number) > 0
          && typeof lifecycleState === "string"
          && lifecycleState.length > 0
        ? {
          version: version as number,
          lifecycle_state: lifecycleState,
        }
        : null;
    },
  };
}

const inertObservations: ConnectorObservationSink = {
  manifest: {
    profile: "connector.observation-sink.v1",
    adapter: "workfabric-debug-inert",
    capabilities: {},
  },
  async record(input) {
    return {
      kind: "accepted",
      receipt_id: `ignored:${input.ingress_id}`,
      event_ids: [],
    };
  },
};

class DebugPluginInstance implements PluginInstance {
  readonly signal_adapter: SignalAdapter;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<void> | null = null;
  private prepared = false;
  private started = false;
  private stopped = true;
  private registered = false;
  private workerHealth: PluginHealth = { state: "healthy", code: "ready" };

  constructor(
    private readonly instanceId: string,
    private readonly config: DebugPluginConfig,
    private readonly worker: ConnectorWorker,
    private readonly http: DebugChannelHttpServer,
    signalAdapter: SignalAdapter,
    private readonly signals: DebugChannelSignalRegistration,
  ) {
    this.signal_adapter = signalAdapter;
  }

  async prepare(): Promise<void> {
    if (this.prepared) return;
    this.signals.register(this.instanceId, this.signal_adapter);
    this.registered = true;
    this.prepared = true;
  }

  async start(): Promise<void> {
    if (!this.prepared) throw new Error("debug_plugin_not_prepared");
    if (this.started) return;
    await this.http.start();
    this.started = true;
    this.stopped = false;
    this.schedule(0);
  }

  async health(): Promise<PluginHealth> {
    if (!this.started) {
      return { state: "degraded", code: "debug_plugin_not_started" };
    }
    const http = this.http.health();
    if (http.state !== "healthy") {
      return { state: "unhealthy", code: `debug_http_${http.code}` };
    }
    return this.workerHealth;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const failures: unknown[] = [];
    try {
      await this.http.stop();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.active;
    } catch (error) {
      failures.push(error);
    }
    if (this.registered) {
      try {
        this.signals.unregister(this.instanceId);
        this.registered = false;
      } catch (error) {
        failures.push(error);
      }
    }
    this.started = false;
    this.prepared = false;
    if (failures.length > 0) {
      throw new Error("debug_plugin_cleanup_failed");
    }
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.active = this.turn().finally(() => {
        this.active = null;
        this.schedule(this.config.worker.poll_interval_ms);
      });
    }, delay);
  }

  private async turn(): Promise<void> {
    try {
      await this.worker.runBatch();
      this.workerHealth = { state: "healthy", code: "ready" };
    } catch {
      this.workerHealth = {
        state: "degraded",
        code: "connector_turn_failed",
      };
    }
  }
}

export class DebugPluginFactory implements PluginFactory {
  readonly type = "collaboration-channel.debug";

  validate(config: unknown): DebugPluginConfig {
    return validateDebugPluginConfig(config);
  }

  async create(
    context: PluginContext,
    instance: PluginInstanceConfiguration,
  ): Promise<PluginInstance> {
    const config = validateDebugPluginConfig(instance.config);
    if (instance.type !== this.type) {
      throw new TypeError("Debug plugin type is invalid");
    }
    if (config.connector_id !== instance.instance_id) {
      throw new TypeError("connector_id must equal plugin instance_id");
    }
    if (context.service.get<boolean>("workfabric.development_mode") !== true) {
      throw new TypeError("Debug Channel requires development_mode");
    }
    const tenantId = context.service.get<string>("workfabric.tenant_id");
    const routes = context.service.get<ChannelRouteStore>("channel.routes");
    const handoffSnapshots =
      context.service.get<ChannelHandoffSnapshotSource>(
        "channel.handoff_snapshot_source",
      );
    const subscriptions = context.service.get<SubscriptionStore>(
      "exchange.subscriptions",
    );
    const ingress = context.service.get<ConnectorIngressStore>(
      "connector.ingress",
    );
    const commandSink = context.service.get<ConnectorCommandSink>(
      "connector.command_sink",
    );
    const signals = context.service.get<DebugChannelSignalRegistration>(
      "channel.signal_registry",
    );
    const diagnostics = context.service.get<DebugChannelStore>(
      "debug.channel_store",
    );
    const clock = context.service.get<DebugClock>("runtime.clock");
    const ids = context.service.get<DebugIdSource>("runtime.debug_ids");
    const cursor = context.service.get<OpaqueCursorCodec>("runtime.debug_cursor");
    const wakeHandoff = context.service.get<(handoffId: string) => void>(
      "runtime.handoff_wakeup",
    );
    const requiresAdmission = Object.values(config.participants).some(
      (participant) => participant.mode === "admission",
    );
    const admission = requiresAdmission
      ? validAdmission(
        context.service.get<unknown>("collaboration.admission"),
      )
      : unavailableAdmission();
    const participantResolver = new ConfiguredDebugParticipantResolver({
      tenant_id: tenantId,
      connector_id: config.connector_id,
      external_tenant_id: config.external_tenant_id,
      participants: config.participants,
      admission,
    });
    const mapper = new DebugEventMapper({
      tenant_id: tenantId,
      connector_id: config.connector_id,
      external_tenant_id: config.external_tenant_id,
      target: config.intake_target,
      delegation: config.delegation,
      accept_within_seconds: config.accept_within_seconds,
      result_due_within_seconds: config.result_due_within_seconds,
      limits: config.limits,
      participant_resolver: participantResolver,
      clock,
    });
    const receipt = new DebugIntakeReceiptHandler({
      plugin_instance_id: instance.instance_id,
      routes,
      subscriptions,
      diagnostics,
      max_delivery_attempts: config.worker.max_attempts,
      on_handoff_ready: wakeHandoff,
    });
    const worker = new ConnectorWorker({
      store: ingress,
      mapper,
      command_sink: commandSink,
      observation_sink: inertObservations,
      accepted_receipt_handler: receipt,
      clock,
      retry_policy: {
        nextAvailableAt(attempt, _code, now) {
          return addSeconds(now, Math.min(300, 2 ** Math.min(attempt, 8)));
        },
      },
      scope: {
        tenant_id: tenantId,
        connector_id: config.connector_id,
        worker_id: `plugin:${instance.instance_id}`,
        lease_seconds: config.worker.lease_seconds,
        batch_limit: config.worker.batch_limit,
        max_attempts: config.worker.max_attempts,
        max_error_detail_length: 256,
      },
    });
    const routeAdapter = new DebugRouteAwareSignalAdapter({
      tenant_id: tenantId,
      plugin_instance_id: instance.instance_id,
      routes,
      diagnostics,
      handoff_snapshots: handoffSnapshots,
      clock,
      retention_days: config.retention.max_age_days,
    });
    const http = new DebugChannelHttpServer({
      tenant_id: tenantId,
      plugin_instance_id: instance.instance_id,
      config,
      ingress,
      diagnostics,
      handoff_snapshots: debugSnapshotSource(handoffSnapshots),
      clock,
      ids,
      cursor,
    });
    return new DebugPluginInstance(
      instance.instance_id,
      config,
      worker,
      http,
      routeAdapter,
      signals,
    );
  }
}
