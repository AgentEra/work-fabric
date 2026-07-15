import type { FastifyInstance, FastifyReply } from "fastify";

import {
  FeishuWebhookError,
  normalizeFeishuEvent,
  verifyFeishuWebhook,
} from "@work-fabric/connector-feishu";

import type { HttpServiceConfig } from "../config.js";
import type { FeishuWebhookDependencies } from "../public-types.js";

function failure(
  reply: FastifyReply,
  status: number,
  code: string,
): FastifyReply {
  return reply.code(status).type("application/problem+json").send({
    type: `urn:work-fabric:problem:${code}`,
    title: code,
    status,
    code,
  });
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Feishu durable acceptance timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function registerFeishuWebhookRoute(
  server: FastifyInstance,
  dependencies: FeishuWebhookDependencies,
  config: HttpServiceConfig,
): void {
  void server.register(async (scope) => {
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser(
      "application/json",
      {
        parseAs: "buffer",
        bodyLimit: config.feishu_webhook_body_limit_bytes,
      },
      (_request, body, done) => done(null, body),
    );
    scope.post<{ Params: { connector_id: string } }>(
      "/v1/connectors/feishu/:connector_id/events",
      async (request, reply) => {
        const binding = await dependencies.binding_resolver.resolve(
          request.params.connector_id,
        );
        if (
          binding === null ||
          binding.route_connector_id !== request.params.connector_id
        ) {
          return failure(reply, 404, "connector_not_found");
        }
        if (!Buffer.isBuffer(request.body)) {
          return failure(reply, 400, "invalid_webhook_body");
        }
        try {
          const credentials =
            await dependencies.credential_provider.loadWebhookCredentials(
              binding.credential_ref,
            );
          const verified = await verifyFeishuWebhook({
            raw_body: request.body,
            ...(typeof request.headers["x-lark-request-timestamp"] === "string"
              ? { timestamp: request.headers["x-lark-request-timestamp"] }
              : {}),
            ...(typeof request.headers["x-lark-request-nonce"] === "string"
              ? { nonce: request.headers["x-lark-request-nonce"] }
              : {}),
            ...(typeof request.headers["x-lark-signature"] === "string"
              ? { signature: request.headers["x-lark-signature"] }
              : {}),
            now_epoch_seconds: dependencies.clock.nowEpochSeconds(),
            credentials,
            limits: {
              max_body_bytes: config.feishu_webhook_body_limit_bytes,
              max_clock_skew_seconds:
                config.feishu_webhook_max_clock_skew_seconds,
              max_json_depth: config.feishu_webhook_max_json_depth,
            },
          });
          if (verified.kind === "challenge") {
            return reply.code(200).send({ challenge: verified.challenge });
          }
          const envelope = normalizeFeishuEvent(verified.body, {
            tenant_id: binding.tenant_id,
            connector_id: binding.connector_id,
            expected_external_tenant_id: binding.external_tenant_id,
            received_at: dependencies.clock.now(),
          });
          const accepted = await withTimeout(
            dependencies.ingress.accept(envelope),
            config.feishu_webhook_accept_timeout_ms,
          );
          return reply.code(200).send({
            accepted: true,
            duplicate: accepted.kind === "duplicate",
            ingress_id: accepted.record.ingress_id,
          });
        } catch (error) {
          if (error instanceof FeishuWebhookError) {
            const unauthorized =
              error.code === "invalid_signature" ||
              error.code === "signature_required" ||
              error.code === "stale_timestamp" ||
              error.code === "invalid_timestamp" ||
              error.code === "invalid_verification_token";
            return failure(
              reply,
              unauthorized ? 401 : 400,
              unauthorized ? "invalid_webhook_authentication" : "invalid_webhook",
            );
          }
          reply.header("retry-after", "1");
          return failure(reply, 503, "webhook_acceptance_unavailable");
        }
      },
    );
  });
}
