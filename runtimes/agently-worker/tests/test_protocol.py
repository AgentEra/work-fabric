from __future__ import annotations

import io

import pytest

from work_fabric_agently_runtime.protocol import (
    ProtocolError,
    completed_record,
    parse_request,
    write_record,
)

from .conftest import valid_request


def test_rejects_secret_inside_task_json() -> None:
    value = valid_request()
    value["task"]["api_key"] = "forbidden"
    with pytest.raises(ProtocolError, match="unknown"):
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


def test_request_rejects_excessive_json_bounds() -> None:
    value = valid_request()
    value["task"]["authority_scope"] = {"nested": {"nested": {"nested": {}}}}
    current = value["task"]["authority_scope"]
    for _ in range(32):
        current["nested"] = {}
        current = current["nested"]
    with pytest.raises(ProtocolError, match="depth"):
        parse_request(value)


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
