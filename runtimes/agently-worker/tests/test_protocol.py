from __future__ import annotations

import io
import json

import pytest

from work_fabric_agently_runtime.protocol import (
    ProtocolError,
    capability_request_record,
    completed_record,
    final_record,
    parse_request,
    read_request,
    utf16_code_units,
    utf8_usv_bytes,
    write_record,
)

from .conftest import valid_request, valid_request_v3


def test_v3_request_accepts_only_summaries_and_a_normalized_transcript() -> None:
    value = valid_request_v3()
    parsed = parse_request(value)
    assert parsed.protocol == "workfabric.agent-runtime/3"
    capabilities = {
        item["capability_id"]: item
        for item in parsed.available_capabilities
    }
    assert "feishu.conversation.history.read" in capabilities
    assert "feishu.document.create" in capabilities
    assert parsed.capability_transcript is None

    value["capability_transcript"] = {"entries": [{
        "request": {
            "invocation_id": "invocation-1",
            "capability_id": "feishu.document.create",
            "version_constraint": "1.0.0",
            "input": {"title": "项目需求"},
            "reason": "创建团队文档",
        },
        "result": {
            "outcome": "failed",
            "invocation_id": "invocation-1",
            "auxiliary_handoff_id": None,
            "code": "provider_unavailable",
            "message": "Provider unavailable",
            "retryable": True,
        },
    }]}
    parsed = parse_request(value)
    assert parsed.capability_transcript is not None
    assert parsed.capability_transcript["entries"][0]["result"]["code"] == "provider_unavailable"

    value["capability_transcript"]["entries"][0]["result"]["api_key"] = "forbidden"
    with pytest.raises(ProtocolError, match="unknown|secret"):
        parse_request(value)


def test_v3_transcript_allows_typed_resource_tokens_but_rejects_credentials() -> None:
    value = valid_request_v3()
    value["capability_transcript"] = {"entries": [{
        "request": {
            "invocation_id": "invocation-1",
            "capability_id": "feishu.document.create",
            "version_constraint": "1.0.0",
            "input": {"title": "项目需求"},
            "reason": "创建团队文档",
        },
        "result": {
            "outcome": "succeeded",
            "invocation_id": "invocation-1",
            "auxiliary_handoff_id": "handoff-capability-1",
            "candidate": {
                "citizen_id": "citizen-feishu",
                "endpoint_id": "endpoint-feishu",
                "capability_id": "feishu.document.create",
                "capability_version": "1.0.0",
                "contract_digest": "sha256:" + "a" * 64,
            },
            "data": {"document_token": "doc-1"},
            "artifacts": [{"uri": "feishu://docx/doc-1"}],
        },
    }]}
    assert parse_request(value).capability_transcript is not None
    value["capability_transcript"]["entries"][0]["result"]["data"]["access_token"] = "forbidden"
    with pytest.raises(ProtocolError, match="secret"):
        parse_request(value)

    value = valid_request_v3()
    value["available_capabilities"][0]["folder_token"] = "forbidden"
    with pytest.raises(ProtocolError, match="unknown|secret"):
        parse_request(value)

    value = valid_request_v3()
    value["available_capabilities"] = value["available_capabilities"] * 33
    with pytest.raises(ProtocolError, match="bound"):
        parse_request(value)


def test_v3_terminal_records_are_strict_final_or_capability_request() -> None:
    final = final_record(
        "command-2",
        {
            "summary": [{"kind": "text", "text": "已完成"}],
            "artifacts": [],
            "evidence": [],
            "extensions": {},
        },
    )
    assert final.protocol == "workfabric.agent-runtime/3"
    assert final.type == "final"
    requested = capability_request_record(
        "command-2",
        {
            "invocation_id": "invocation-2",
            "capability_id": "feishu.document.create",
            "version_constraint": "^1.0.0",
            "input": {"title": "项目需求"},
            "reason": "创建团队文档",
        },
    )
    assert requested.protocol == "workfabric.agent-runtime/3"
    assert requested.type == "capability_request"


def test_rejects_secret_inside_task_json() -> None:
    value = valid_request()
    value["task"]["api_key"] = "forbidden"
    with pytest.raises(ProtocolError, match="unknown"):
        parse_request(value)

def test_request_requires_bounded_resolved_context() -> None:
    value = valid_request()
    parsed = parse_request(value)
    assert parsed.task["resolved_context"]["context_id"] == "handoff-context-1"

    del value["task"]["resolved_context"]
    with pytest.raises(ProtocolError, match="unknown|missing"):
        parse_request(value)

    value = valid_request()
    value["task"]["resolved_context"] = {"text": "x" * 131_073}
    with pytest.raises(ProtocolError, match="bound"):
        parse_request(value)


def test_completed_record_requires_non_empty_summary() -> None:
    with pytest.raises(ProtocolError, match="summary"):
        completed_record(
            "command-1",
            {"summary": [], "artifacts": [], "evidence": [], "extensions": {}},
        )


def test_request_rejects_unknown_or_non_json_task_values() -> None:
    value = valid_request()
    value["task"]["role"]["api_key"] = "forbidden"
    with pytest.raises(ProtocolError, match="unknown"):
        parse_request(value)

    value = valid_request()
    value["task"]["intent"] = [object()]
    with pytest.raises(ProtocolError, match="JSON"):
        parse_request(value)


def test_rejects_secret_named_fields_at_any_task_depth() -> None:
    value = valid_request()
    value["task"]["authority_scope"] = {"delegation": {"api_key": "forbidden"}}
    with pytest.raises(ProtocolError, match="secret"):
        parse_request(value)

    value = valid_request()
    value["task"]["agent_private_context"] = {
        "session": {"access_token": "forbidden"}
    }
    with pytest.raises(ProtocolError, match="secret"):
        parse_request(value)


def test_request_rejects_excessive_json_bounds() -> None:
    value = valid_request()
    value["task"]["authority_scope"] = {"nested": {"nested": {"nested": {}}}}
    current = value["task"]["authority_scope"]
    for _ in range(32):
        current["nested"] = {}
        current = current["nested"]
    with pytest.raises(ProtocolError, match="depth"):
        parse_request(value)


def test_matches_node_utf16_string_and_key_limits() -> None:
    value = valid_request()
    value["command_id"] = "😀" * 65
    with pytest.raises(ProtocolError, match="command_id"):
        parse_request(value)


def test_surrogates_use_node_usv_string_bytes_without_raw_encoding_errors() -> None:
    lone_surrogate = "\ud800"
    assert utf16_code_units(lone_surrogate) == 1
    assert utf8_usv_bytes(lone_surrogate) == 3
    assert utf16_code_units("😀") == 2
    assert utf8_usv_bytes("😀") == 4

    value = valid_request()
    value["command_id"] = lone_surrogate
    escaped_lone = json.loads(json.dumps(value, ensure_ascii=True))
    assert parse_request(escaped_lone).command_id == "�"

    value["command_id"] = "😀"
    escaped_pair = json.loads(json.dumps(value, ensure_ascii=True))
    assert parse_request(escaped_pair).command_id == "😀"

    stream = io.StringIO()
    write_record(
        stream,
        completed_record(
            "command-1",
            {
                "summary": [{"kind": "text", "media_type": "text/plain", "text": lone_surrogate}],
                "artifacts": [],
                "evidence": [],
                "extensions": {},
            },
        ),
    )
    assert json.loads(stream.getvalue())["result"]["summary"][0]["text"] == "�"

    value = valid_request()
    value["task"]["authority_scope"] = {"😀" * 129: "value"}
    with pytest.raises(ProtocolError, match="key"):
        parse_request(value)


@pytest.mark.parametrize("prefix, suffix", [(b"\n", b""), (b"", b"\n\n"), (b"", b"\n \n")])
def test_read_request_allows_only_one_json_line_and_one_optional_newline(prefix: bytes, suffix: bytes) -> None:
    raw = json.dumps(valid_request(), separators=(",", ":")).encode("utf-8")
    with pytest.raises(ProtocolError, match="exactly one"):
        read_request(io.BytesIO(prefix + raw + suffix))


def test_write_record_is_compact_ndjson_and_flushes() -> None:
    stream = io.StringIO()
    write_record(
        stream,
        completed_record(
            "command-1",
            {
                "summary": [{"kind": "text", "media_type": "text/plain", "text": "done"}],
                "artifacts": [],
                "evidence": [],
                "extensions": {},
            },
        ),
    )
    assert stream.getvalue().endswith("\n")
    assert "\n" not in stream.getvalue()[:-1]
    assert ", " not in stream.getvalue()
