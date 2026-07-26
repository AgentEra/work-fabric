from __future__ import annotations

import asyncio
import os
import sys
from collections.abc import Awaitable, Callable, Mapping
from datetime import datetime, timezone
from typing import TextIO

from .assistant import execute as execute_agently
from .assistant import validate_assistant_output
from .protocol import JsonValue, WorkerRequest, completed_record, failed_record, progress_record, write_record

Executor = Callable[[WorkerRequest], Awaitable[Mapping[str, JsonValue]]]


def _observed_at() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _diagnostic(stderr: TextIO, message: str) -> None:
    stderr.write(message[:8_192] + "\n")
    stderr.flush()


def _contains_secret(value: object, secrets: tuple[str, ...]) -> bool:
    if isinstance(value, str):
        return any(secret in value for secret in secrets)
    if isinstance(value, list):
        return any(_contains_secret(item, secrets) for item in value)
    if isinstance(value, dict):
        return any(_contains_secret(key, secrets) or _contains_secret(item, secrets) for key, item in value.items())
    return False


def _task_contains_secret(value: object, secrets: tuple[str, ...]) -> bool:
    if isinstance(value, str):
        return any(value == secret for secret in secrets)
    if isinstance(value, list):
        return any(_task_contains_secret(item, secrets) for item in value)
    if isinstance(value, dict):
        return any(_task_contains_secret(key, secrets) or _task_contains_secret(item, secrets) for key, item in value.items())
    return False


async def run(
    request: WorkerRequest,
    *,
    execute: Executor = execute_agently,
    stdout: TextIO = sys.stdout,
    stderr: TextIO = sys.stderr,
    secrets: tuple[str, ...] = (),
) -> int:
    environment_secret = os.environ.get("AGENTLY_MODEL_API_KEY", "")
    secrets = tuple(secret for secret in (*secrets, environment_secret) if secret)
    write_record(stdout, progress_record(request.command_id, 1, 0.0, "Agently worker started", _observed_at()))
    try:
        if _task_contains_secret(request.task, secrets):
            raise ValueError("worker task contains a configured secret")
        output = validate_assistant_output(await execute(request))
        if _contains_secret(output, secrets):
            raise ValueError("model output contains a configured secret")
        write_record(stdout, progress_record(request.command_id, 2, 1.0, "Agently worker completed model response", _observed_at()))
        result: dict[str, JsonValue] = {
            "summary": [{"kind": "text", "media_type": "text/plain", "text": output["response"]}],
            "artifacts": [],
            "evidence": [],
            "extensions": {"workfabric.agent/assistant_output": output},
        }
        write_record(stdout, completed_record(request.command_id, result))
        return 0
    except asyncio.CancelledError:
        raise
    except Exception:
        safe_message = "Agently worker execution failed"
        for secret in secrets:
            safe_message = safe_message.replace(secret, "[REDACTED]")
        _diagnostic(stderr, safe_message)
        write_record(stdout, failed_record(request.command_id, "execution_failed", "Agently worker could not complete the request", False))
        return 1
