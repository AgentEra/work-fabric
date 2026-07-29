export function validDebugConfig() {
  return {
    connector_id: "debug-local",
    external_tenant_id: "debug-fixtures",
    listen: { host: "127.0.0.1", port: 8791 },
    credentials: { bearer_token: "${WORK_FABRIC_DEBUG_TOKEN}" },
    intake_target: {
      actor_id: "actor-daily-assistant",
      endpoint_id: "endpoint-daily-assistant-local",
    },
    participants: {
      "internal-user": {
        mode: "static",
        external_subject_type: "human",
        external_subject_id: "fixture-internal-user",
        actor_id: "actor-debug-user",
        actor_type: "human",
        endpoint_id: "endpoint-debug-user",
      },
      "admitted-user": {
        mode: "admission",
        external_subject_type: "human",
        external_subject_id: "fixture-admitted-user",
        policy_id: "debug-local-admission",
      },
    },
    limits: {
      max_request_bytes: 262_144,
      max_content_parts: 32,
      max_text_bytes: 131_072,
      max_json_depth: 32,
      max_page_size: 100,
    },
    retention: {
      max_age_days: 14,
      cleanup_batch_size: 500,
    },
  } as const;
}
