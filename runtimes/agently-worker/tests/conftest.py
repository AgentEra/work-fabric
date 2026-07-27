from __future__ import annotations

from typing import Any


def valid_request() -> dict[str, Any]:
    return {
        "protocol": "workfabric.agent-runtime/1",
        "command_id": "command-1",
        "task": {
            "tenant_id": "tenant-1",
            "handoff_id": "handoff-1",
            "thread_id": "thread-1",
            "stream_version": 1,
            "role": {
                "role_id": "daily-assistant",
                "version": 1,
                "display_name": "Daily",
                "description": "Daily assistant",
                "capability_ids": ["information.synthesis"],
            },
            "capability_id": "information.synthesis",
            "intent": [{"kind": "text", "text": "Summarize this request"}],
            "context_reference": {"reference": "handoff-context-1"},
            "authority_scope": {},
            "acceptance_criteria": [{"kind": "text", "text": "A clear response"}],
            "priority": "normal",
            "accept_by": "2026-07-26T00:00:00.000Z",
            "result_due_at": "2026-07-26T01:00:00.000Z",
            "workspace_path": "/tmp/work-fabric/tenant-1/handoff-1",
        },
        "provider": {
            "type": "OpenAICompatible",
            "base_url": "https://model.example.test/v1",
            "model": "test-model",
        },
    }


def valid_request_v2() -> dict[str, Any]:
    value = valid_request()
    value["protocol"] = "workfabric.agent-runtime/2"
    value["continuation"] = None
    return value
