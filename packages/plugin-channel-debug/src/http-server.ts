import {
  createHash,
  timingSafeEqual,
} from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { isIP } from "node:net";

import type { ConnectorIngressStore } from "@work-fabric/connector-spi";
import type { DebugChannelStore } from "@work-fabric/debug-channel-spi";
import type { OpaqueCursorCodec } from "@work-fabric/operations-spi";

import type { DebugPluginConfig } from "./config.js";
import {
  debugMessageDigest,
  normalizeDebugMessage,
} from "./content.js";
import { DebugHttpError } from "./http-errors.js";
import { debugMessageIngress } from "./ingress-normalizer.js";
import {
  DebugSubmissionStatusSource,
  type DebugHandoffSnapshotSource,
} from "./status-source.js";

export interface DebugIdSource {
  requestId(): string;
  submissionId(): string;
}

export interface DebugClock {
  now(): string;
}

export interface DebugChannelHttpServerOptions {
  readonly tenant_id: string;
  readonly plugin_instance_id: string;
  readonly config: DebugPluginConfig;
  readonly ingress: ConnectorIngressStore;
  readonly diagnostics: DebugChannelStore;
  readonly handoff_snapshots: DebugHandoffSnapshotSource;
  readonly clock: DebugClock;
  readonly ids: DebugIdSource;
  readonly cursor: OpaqueCursorCodec;
}

export interface DebugHttpAddress {
  readonly host: string;
  readonly port: number;
}

type Route =
  | { readonly kind: "health" }
  | { readonly kind: "submit"; readonly conversation_id: string }
  | { readonly kind: "submission"; readonly submission_id: string }
  | { readonly kind: "events"; readonly conversation_id: string }
  | { readonly kind: "event"; readonly capture_id: string }
  | { readonly kind: "unknown" };

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function tokenMatches(expected: string, authorization: string | undefined): boolean {
  const prefix = "Bearer ";
  const candidate = authorization?.startsWith(prefix)
    ? authorization.slice(prefix.length)
    : "";
  return timingSafeEqual(sha256(expected), sha256(candidate));
}

function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body).toString(),
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(body);
}

function boundedPathPart(value: string, maximum: number): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new DebugHttpError(400, "invalid_request");
  }
  if (
    decoded.length === 0
    || decoded.length > maximum
    || decoded.trim() !== decoded
    || /[\0\r\n]/u.test(decoded)
  ) {
    throw new DebugHttpError(400, "invalid_request");
  }
  return decoded;
}

function route(pathname: string): Route {
  if (pathname === "/health") return { kind: "health" };
  let match = /^\/v1\/conversations\/([^/]+)\/messages$/u.exec(pathname);
  if (match?.[1] !== undefined) {
    return {
      kind: "submit",
      conversation_id: boundedPathPart(match[1], 512),
    };
  }
  match = /^\/v1\/submissions\/([^/]+)$/u.exec(pathname);
  if (match?.[1] !== undefined) {
    return {
      kind: "submission",
      submission_id: boundedPathPart(match[1], 96),
    };
  }
  match = /^\/v1\/conversations\/([^/]+)\/events$/u.exec(pathname);
  if (match?.[1] !== undefined) {
    return {
      kind: "events",
      conversation_id: boundedPathPart(match[1], 512),
    };
  }
  match = /^\/v1\/events\/([^/]+)$/u.exec(pathname);
  if (match?.[1] !== undefined) {
    return {
      kind: "event",
      capture_id: boundedPathPart(match[1], 128),
    };
  }
  return { kind: "unknown" };
}

async function readJson(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new DebugHttpError(400, "invalid_request");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maximumBytes) {
      throw new DebugHttpError(413, "payload_too_large");
    }
    chunks.push(bytes);
  }
  if (size === 0) throw new DebugHttpError(400, "invalid_request");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DebugHttpError(400, "invalid_request");
  }
}

function expiry(now: string, days: number): string {
  return new Date(Date.parse(now) + days * 86_400_000).toISOString();
}

function cursorContext(
  tenantId: string,
  pluginInstanceId: string,
  conversationId: string,
) {
  return {
    kind: "operations" as const,
    sort: "captured_at,capture_id",
    filters: {
      tenant_id: tenantId,
      plugin_instance_id: pluginInstanceId,
      conversation_id: conversationId,
    },
  };
}

function pageLimit(value: string | null, maximum: number): number {
  if (value === null) return Math.min(25, maximum);
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new DebugHttpError(400, "invalid_request");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new DebugHttpError(400, "invalid_request");
  }
  return parsed;
}

function loopback(host: string): boolean {
  const family = isIP(host);
  return (family === 4 && host.startsWith("127."))
    || (family === 6 && host === "::1");
}

export class DebugChannelHttpServer {
  private server: Server | null = null;
  private state: "stopped" | "starting" | "listening" | "stopping" = "stopped";
  private readonly statusSource: DebugSubmissionStatusSource;

  constructor(private readonly options: DebugChannelHttpServerOptions) {
    if (!loopback(options.config.listen.host)) {
      throw new TypeError("Debug HTTP server requires a loopback IP address");
    }
    if (
      !Number.isSafeInteger(options.config.listen.port)
      || options.config.listen.port < 0
      || options.config.listen.port > 65_535
    ) {
      throw new TypeError("Debug HTTP port is invalid");
    }
    this.statusSource = new DebugSubmissionStatusSource({
      tenant_id: options.tenant_id,
      plugin_instance_id: options.plugin_instance_id,
      connector_id: options.config.connector_id,
      diagnostics: options.diagnostics,
      ingress: options.ingress,
      handoff_snapshots: options.handoff_snapshots,
    });
  }

  health(): {
    readonly state: "healthy" | "degraded";
    readonly code: string;
  } {
    return this.state === "listening"
      ? { state: "healthy", code: "listening" }
      : { state: "degraded", code: this.state };
  }

  async start(): Promise<DebugHttpAddress> {
    if (this.server !== null || this.state !== "stopped") {
      throw new Error("Debug HTTP server is already started");
    }
    this.state = "starting";
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(
          this.options.config.listen.port,
          this.options.config.listen.host,
        );
      });
    } catch (error) {
      this.server = null;
      this.state = "stopped";
      throw error;
    }
    const address = server.address();
    if (address === null || typeof address === "string") {
      await this.stop();
      throw new Error("Debug HTTP server has no TCP address");
    }
    this.state = "listening";
    return {
      host: this.options.config.listen.host,
      port: address.port,
    };
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === null) {
      this.state = "stopped";
      return;
    }
    this.server = null;
    this.state = "stopping";
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
      const timer = setTimeout(() => {
        server.closeAllConnections();
      }, 5_000);
      timer.unref();
    });
    this.state = "stopped";
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const requestId = this.options.ids.requestId();
    try {
      const url = new URL(request.url ?? "/", "http://debug.invalid");
      const matched = route(url.pathname);
      if (matched.kind === "health") {
        if (request.method !== "GET") {
          throw new DebugHttpError(405, "method_not_allowed");
        }
        writeJson(response, 200, this.health());
        return;
      }
      if (!tokenMatches(
        this.options.config.credentials.bearer_token,
        request.headers.authorization,
      )) {
        throw new DebugHttpError(401, "authentication_required");
      }
      if (matched.kind === "unknown") {
        throw new DebugHttpError(404, "not_found");
      }
      if (matched.kind === "submit") {
        if (request.method !== "POST") {
          throw new DebugHttpError(405, "method_not_allowed");
        }
        await this.submit(matched.conversation_id, request, response);
        return;
      }
      if (request.method !== "GET") {
        throw new DebugHttpError(405, "method_not_allowed");
      }
      if (matched.kind === "submission") {
        const value = await this.statusSource.load(matched.submission_id);
        if (value === null) throw new DebugHttpError(404, "not_found");
        writeJson(response, 200, value);
        return;
      }
      if (matched.kind === "event") {
        const capture = await this.options.diagnostics.getCapture({
          tenant_id: this.options.tenant_id,
          plugin_instance_id: this.options.plugin_instance_id,
          capture_id: matched.capture_id,
        });
        if (capture === null) throw new DebugHttpError(404, "not_found");
        writeJson(response, 200, capture);
        return;
      }
      await this.listEvents(matched.conversation_id, url, response);
    } catch (error) {
      const failure = error instanceof DebugHttpError
        ? error
        : new DebugHttpError(400, "invalid_request");
      if (!response.headersSent) {
        writeJson(response, failure.status, {
          error: {
            code: failure.code,
            request_id: requestId,
          },
        }, failure.status === 401
          ? { "www-authenticate": 'Bearer realm="work-fabric-debug"' }
          : {});
      } else {
        response.destroy();
      }
    }
  }

  private async submit(
    conversationId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await readJson(
      request,
      this.options.config.limits.max_request_bytes,
    );
    const message = normalizeDebugMessage(body, this.options.config.limits);
    if (!Object.hasOwn(this.options.config.participants, message.participant_ref)) {
      throw new DebugHttpError(403, "forbidden_participant");
    }
    const now = this.options.clock.now();
    const candidateId = this.options.ids.submissionId();
    const created = await this.options.diagnostics.createSubmission({
      submission: {
        tenant_id: this.options.tenant_id,
        plugin_instance_id: this.options.plugin_instance_id,
        submission_id: candidateId,
        conversation_id: conversationId,
        idempotency_key: message.idempotency_key,
        request_digest: debugMessageDigest(message),
        created_at: now,
        updated_at: now,
        expires_at: expiry(now, this.options.config.retention.max_age_days),
      },
    });
    if (created.kind === "conflict") {
      throw new DebugHttpError(409, "idempotency_conflict");
    }
    let submission = created.submission;
    if (submission.ingress_id === undefined) {
      const accepted = await this.options.ingress.accept(debugMessageIngress({
        tenant_id: this.options.tenant_id,
        connector_id: this.options.config.connector_id,
        external_tenant_id: this.options.config.external_tenant_id,
        submission_id: submission.submission_id,
        conversation_id: conversationId,
        message,
        occurred_at: now,
        received_at: now,
      }));
      submission = await this.options.diagnostics.linkIngress({
        tenant_id: this.options.tenant_id,
        plugin_instance_id: this.options.plugin_instance_id,
        submission_id: submission.submission_id,
        ingress_id: accepted.record.ingress_id,
        updated_at: now,
      });
    }
    const ingress = submission.ingress_id === undefined
      ? null
      : await this.options.ingress.get({
        tenant_id: this.options.tenant_id,
        connector_id: this.options.config.connector_id,
        ingress_id: submission.ingress_id,
      });
    writeJson(response, 202, {
      submission_id: submission.submission_id,
      ingress_id: submission.ingress_id,
      ingress_state: ingress?.state ?? "not_available",
    });
  }

  private async listEvents(
    conversationId: string,
    url: URL,
    response: ServerResponse,
  ): Promise<void> {
    const limit = pageLimit(
      url.searchParams.get("limit"),
      this.options.config.limits.max_page_size,
    );
    const context = cursorContext(
      this.options.tenant_id,
      this.options.plugin_instance_id,
      conversationId,
    );
    const cursor = url.searchParams.get("cursor");
    let afterCapturedAt: string | undefined;
    let afterCaptureId: string | undefined;
    if (cursor !== null) {
      let position;
      try {
        position = await this.options.cursor.decode(cursor, context);
      } catch {
        throw new DebugHttpError(400, "invalid_request");
      }
      if (
        typeof position.captured_at !== "string"
        || typeof position.capture_id !== "string"
      ) {
        throw new DebugHttpError(400, "invalid_request");
      }
      afterCapturedAt = position.captured_at;
      afterCaptureId = position.capture_id;
    }
    const page = await this.options.diagnostics.listCaptures({
      tenant_id: this.options.tenant_id,
      plugin_instance_id: this.options.plugin_instance_id,
      conversation_id: conversationId,
      ...(afterCapturedAt === undefined
        ? {}
        : {
          after_captured_at: afterCapturedAt,
          after_capture_id: afterCaptureId!,
        }),
      limit,
    });
    const last = page.items.at(-1);
    const nextCursor = last === undefined || page.items.length < limit
      ? undefined
      : await this.options.cursor.encode({
        ...context,
        position: {
          captured_at: last.captured_at,
          capture_id: last.capture_id,
        },
      });
    writeJson(response, 200, {
      items: page.items,
      ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }),
    });
  }
}
