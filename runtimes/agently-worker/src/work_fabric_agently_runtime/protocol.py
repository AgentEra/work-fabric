from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass
from typing import Literal, Mapping, TextIO, TypeAlias

PROTOCOL = "workfabric.agent-runtime/1"
TURN_PROTOCOL = "workfabric.agent-runtime/2"
MAX_JSON_DEPTH = 32
MAX_JSON_NODES = 10_000
MAX_JSON_STRING_BYTES = 131_072
MAX_JSON_KEY_LENGTH = 256
MAX_STDOUT_LINE_BYTES = 262_144
SECRET_FIELD = re.compile(r"(?:api[_-]?key|secret|token|password|credential)", re.IGNORECASE)

JsonValue: TypeAlias = None | bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"]


class ProtocolError(ValueError):
    """Raised when an untrusted worker boundary value is invalid."""


@dataclass(frozen=True)
class WorkerRequest:
    protocol: Literal["workfabric.agent-runtime/1", "workfabric.agent-runtime/2"]
    command_id: str
    task: Mapping[str, JsonValue]
    continuation: Mapping[str, JsonValue] | None
    provider_type: Literal["OpenAICompatible"]
    provider_base_url: str
    provider_model: str


@dataclass(frozen=True)
class WorkerRecord:
    protocol: Literal["workfabric.agent-runtime/1", "workfabric.agent-runtime/2"]
    type: Literal["progress", "completed", "final", "capability_request", "failed"]
    command_id: str
    payload: Mapping[str, JsonValue]


@dataclass
class _JsonBudget:
    nodes: int = 0
    string_bytes: int = 0


def _fail(message: str) -> None:
    raise ProtocolError(message)


def usv_string(value: str) -> str:
    return "".join("\ufffd" if 0xD800 <= ord(character) <= 0xDFFF else character for character in value)


def utf16_code_units(value: str) -> int:
    return sum(2 if ord(character) > 0xFFFF else 1 for character in value)


def utf8_usv_bytes(value: str) -> int:
    return len(usv_string(value).encode("utf-8"))


def _string(value: object, label: str, maximum: int) -> str:
    if not isinstance(value, str) or not value or value.strip() != value or utf16_code_units(value) > maximum:
        _fail(f"{label} is invalid")
    return usv_string(value)


def _exact_object(value: object, fields: tuple[str, ...], label: str) -> dict[str, object]:
    if not isinstance(value, dict) or set(value) != set(fields) or len(value) != len(fields):
        _fail(f"{label} contains unknown or missing fields")
    return value


def _json(value: object, budget: _JsonBudget, depth: int = 0) -> JsonValue:
    if depth > MAX_JSON_DEPTH:
        _fail("worker JSON exceeds maximum depth")
    budget.nodes += 1
    if budget.nodes > MAX_JSON_NODES:
        _fail("worker JSON exceeds maximum node bound")
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, str):
        value = usv_string(value)
        budget.string_bytes += utf8_usv_bytes(value)
        if budget.string_bytes > MAX_JSON_STRING_BYTES:
            _fail("worker JSON string bytes exceed maximum bound")
        return value
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            _fail("worker JSON number is invalid")
        return value
    if isinstance(value, list):
        return [_json(item, budget, depth + 1) for item in value]
    if not isinstance(value, dict):
        _fail("worker JSON is invalid")
    output: dict[str, JsonValue] = {}
    for key, child in value.items():
        if not isinstance(key, str) or utf16_code_units(key) > MAX_JSON_KEY_LENGTH:
            _fail("worker JSON key is invalid")
        key = usv_string(key)
        if key in output:
            _fail("worker JSON keys collapse under USV normalization")
        budget.string_bytes += utf8_usv_bytes(key)
        if budget.string_bytes > MAX_JSON_STRING_BYTES:
            _fail("worker JSON string bytes exceed maximum bound")
        output[key] = _json(child, budget, depth + 1)
    return output


def _json_object(value: object, label: str) -> dict[str, JsonValue]:
    parsed = _json(value, _JsonBudget())
    if not isinstance(parsed, dict):
        _fail(f"{label} must be a JSON object")
    return parsed


def _reject_secret_fields(value: JsonValue) -> None:
    if isinstance(value, list):
        for item in value:
            _reject_secret_fields(item)
    elif isinstance(value, dict):
        for key, item in value.items():
            if SECRET_FIELD.search(key):
                _fail("task contains a secret-named field")
            _reject_secret_fields(item)


def _validate_role(value: object) -> dict[str, JsonValue]:
    role = _exact_object(value, ("role_id", "version", "display_name", "description", "capability_ids"), "task.role")
    _string(role["role_id"], "task.role.role_id", 128)
    if not isinstance(role["version"], int) or isinstance(role["version"], bool) or role["version"] < 1:
        _fail("task.role.version is invalid")
    _string(role["display_name"], "task.role.display_name", 8_192)
    _string(role["description"], "task.role.description", 8_192)
    capabilities = role["capability_ids"]
    if not isinstance(capabilities, list) or not capabilities:
        _fail("task.role.capability_ids is invalid")
    for item in capabilities:
        _string(item, "task.role.capability_ids", 128)
    return _json_object(role, "task.role")


def _validate_task(value: object) -> dict[str, JsonValue]:
    fields = (
        "tenant_id", "handoff_id", "thread_id", "stream_version", "role", "capability_id",
        "intent", "context_reference", "authority_scope", "acceptance_criteria", "priority",
        "accept_by", "result_due_at", "workspace_path",
    )
    task = _exact_object(value, fields, "task")
    for key in ("tenant_id", "handoff_id", "thread_id", "accept_by", "result_due_at", "workspace_path"):
        _string(task[key], f"task.{key}", 8_192)
    if not isinstance(task["stream_version"], int) or isinstance(task["stream_version"], bool) or task["stream_version"] < 1:
        _fail("task.stream_version is invalid")
    _validate_role(task["role"])
    if task["capability_id"] is not None:
        _string(task["capability_id"], "task.capability_id", 128)
    if task["priority"] not in ("low", "normal", "high", "critical"):
        _fail("task.priority is invalid")
    for key in ("intent", "acceptance_criteria"):
        if not isinstance(task[key], list) or any(not isinstance(item, dict) for item in task[key]):
            _fail(f"task.{key} is invalid")
    if task["context_reference"] is not None and not isinstance(task["context_reference"], dict):
        _fail("task.context_reference is invalid")
    if not isinstance(task["authority_scope"], dict):
        _fail("task.authority_scope is invalid")
    safe_task = _json_object(task, "task")
    _reject_secret_fields(safe_task)
    return safe_task


def _validate_capability_request(value: object) -> dict[str, JsonValue]:
    request = _exact_object(
        value,
        ("invocation_id", "capability_id", "version_constraint", "input", "reason"),
        "continuation.request",
    )
    for field in ("invocation_id", "capability_id", "version_constraint", "reason"):
        _string(request[field], f"continuation.request.{field}", 8_192)
    if not isinstance(request["input"], dict):
        _fail("continuation.request.input is invalid")
    return _json_object(request, "continuation.request")


def _validate_capability_result(value: object) -> dict[str, JsonValue]:
    if not isinstance(value, dict):
        _fail("continuation.result contains unknown or missing fields")
    outcome = value.get("outcome")
    if outcome == "succeeded":
        result = _exact_object(
            value,
            (
                "outcome", "invocation_id", "auxiliary_handoff_id", "candidate",
                "data", "artifacts",
            ),
            "continuation.result",
        )
        candidate = _exact_object(
            result["candidate"],
            (
                "citizen_id", "endpoint_id", "capability_id",
                "capability_version", "contract_digest",
            ),
            "continuation.result.candidate",
        )
        for field in candidate:
            _string(candidate[field], f"continuation.result.candidate.{field}", 256)
        if not isinstance(result["data"], dict):
            _fail("continuation.result.data is invalid")
        if not isinstance(result["artifacts"], list) or any(
            not isinstance(item, dict) for item in result["artifacts"]
        ):
            _fail("continuation.result.artifacts is invalid")
    elif outcome in ("rejected", "failed"):
        result = _exact_object(
            value,
            (
                "outcome", "invocation_id", "auxiliary_handoff_id",
                "code", "message", "retryable",
            ),
            "continuation.result",
        )
        for field in ("invocation_id", "code", "message"):
            _string(result[field], f"continuation.result.{field}", 8_192)
        if result["auxiliary_handoff_id"] is not None:
            _string(
                result["auxiliary_handoff_id"],
                "continuation.result.auxiliary_handoff_id",
                128,
            )
        if not isinstance(result["retryable"], bool):
            _fail("continuation.result.retryable is invalid")
    else:
        _fail("continuation.result.outcome is invalid")
    return _json_object(result, "continuation.result")


def _validate_continuation(value: object) -> dict[str, JsonValue]:
    continuation = _exact_object(
        value,
        ("request", "result"),
        "continuation",
    )
    request = _validate_capability_request(continuation["request"])
    result = _validate_capability_result(continuation["result"])
    if request["invocation_id"] != result["invocation_id"]:
        _fail("continuation invocation_id does not match")
    safe = {"request": request, "result": result}
    _reject_secret_fields(safe)
    return safe


def parse_request(value: object) -> WorkerRequest:
    safe = _json(value, _JsonBudget())
    if not isinstance(safe, dict):
        _fail("request contains unknown or missing fields")
    protocol = safe.get("protocol")
    fields = (
        ("protocol", "command_id", "task", "provider")
        if protocol == PROTOCOL
        else ("protocol", "command_id", "task", "continuation", "provider")
    )
    request = _exact_object(safe, fields, "request")
    if protocol not in (PROTOCOL, TURN_PROTOCOL):
        _fail("request protocol is unsupported")
    command_id = _string(request["command_id"], "request.command_id", 128)
    task = _validate_task(request["task"])
    provider = _exact_object(request["provider"], ("type", "base_url", "model"), "provider")
    if provider["type"] != "OpenAICompatible":
        _fail("provider.type is unsupported")
    return WorkerRequest(
        protocol=protocol,
        command_id=command_id,
        task=task,
        continuation=(
            None
            if protocol == PROTOCOL or request["continuation"] is None
            else _validate_continuation(request["continuation"])
        ),
        provider_type="OpenAICompatible",
        provider_base_url=_string(provider["base_url"], "provider.base_url", 8_192),
        provider_model=_string(provider["model"], "provider.model", 8_192),
    )


def _result(value: object) -> dict[str, JsonValue]:
    result = _exact_object(value, ("summary", "artifacts", "evidence", "extensions"), "result")
    if not isinstance(result["summary"], list) or not result["summary"]:
        _fail("result.summary must be a non-empty array")
    for name in ("summary", "artifacts", "evidence"):
        if not isinstance(result[name], list) or any(not isinstance(item, dict) for item in result[name]):
            _fail(f"result.{name} is invalid")
    if not isinstance(result["extensions"], dict):
        _fail("result.extensions is invalid")
    return _json_object(result, "result")


def progress_record(
    command_id: str,
    sequence: int,
    progress: float | None,
    message: str,
    observed_at: str,
    protocol: Literal["workfabric.agent-runtime/1", "workfabric.agent-runtime/2"] = PROTOCOL,
) -> WorkerRecord:
    if not isinstance(sequence, int) or isinstance(sequence, bool) or sequence < 1:
        _fail("progress sequence is invalid")
    if progress is not None and (not isinstance(progress, (int, float)) or isinstance(progress, bool) or not 0 <= progress <= 1):
        _fail("progress value is invalid")
    if protocol not in (PROTOCOL, TURN_PROTOCOL):
        _fail("record protocol is unsupported")
    return WorkerRecord(protocol, "progress", _string(command_id, "command_id", 128), {
        "sequence": sequence, "progress": progress, "message": _string(message, "progress message", 8_192),
        "observed_at": _string(observed_at, "progress timestamp", 128),
    })


def completed_record(command_id: str, result: object) -> WorkerRecord:
    return WorkerRecord(PROTOCOL, "completed", _string(command_id, "command_id", 128), {"result": _result(result)})


def final_record(command_id: str, response: object) -> WorkerRecord:
    return WorkerRecord(
        TURN_PROTOCOL,
        "final",
        _string(command_id, "command_id", 128),
        {"response": _result(response)},
    )


def capability_request_record(command_id: str, value: object) -> WorkerRecord:
    return WorkerRecord(
        TURN_PROTOCOL,
        "capability_request",
        _string(command_id, "command_id", 128),
        {"request": _validate_capability_request(value)},
    )


def failed_record(
    command_id: str,
    code: str,
    message: str,
    retryable: bool,
    protocol: Literal["workfabric.agent-runtime/1", "workfabric.agent-runtime/2"] = PROTOCOL,
) -> WorkerRecord:
    if not isinstance(retryable, bool):
        _fail("failure retryable is invalid")
    if protocol not in (PROTOCOL, TURN_PROTOCOL):
        _fail("record protocol is unsupported")
    return WorkerRecord(protocol, "failed", _string(command_id, "command_id", 128), {
        "code": _string(code, "failure code", 128), "message": _string(message, "failure message", 8_192), "retryable": retryable,
    })


def record_json(record: WorkerRecord) -> dict[str, JsonValue]:
    return {"protocol": record.protocol, "type": record.type, "command_id": record.command_id, **record.payload}


def write_record(stream: TextIO, record: WorkerRecord) -> None:
    encoded = json.dumps(record_json(record), ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    if len(encoded.encode("utf-8")) > MAX_STDOUT_LINE_BYTES:
        _fail("worker record exceeds stdout bound")
    stream.write(encoded + "\n")
    stream.flush()


def read_request(stream: object = None) -> WorkerRequest:
    input_stream = sys.stdin.buffer if stream is None else stream
    raw = input_stream.read(1_048_577)
    if not isinstance(raw, bytes) or len(raw) > 1_048_576:
        _fail("worker request exceeds input bound")
    try:
        if raw.endswith(b"\n"):
            raw = raw[:-1]
        if not raw or b"\n" in raw or b"\r" in raw:
            _fail("worker request must be exactly one NDJSON record")
        return parse_request(json.loads(raw.decode("utf-8")))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProtocolError("worker request is invalid JSON") from error
