from __future__ import annotations

import io
import json
import os
import subprocess
import sys

import pytest

from work_fabric_agently_runtime.protocol import parse_request
from work_fabric_agently_runtime.runner import run

from .conftest import valid_request, valid_request_v3


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("turn", "terminal_type"),
    [
        (
            {
                "kind": "capability_request",
                "request": {
                    "invocation_id": "invocation-1",
                    "capability_id": "feishu.document.create",
                    "version_constraint": "1.0.0",
                    "input": {"title": "项目需求"},
                    "reason": "创建团队文档",
                },
            },
            "capability_request",
        ),
        (
            {
                "kind": "final",
                "response": {
                    "summary": [{"kind": "text", "text": "已完成"}],
                    "artifacts": [],
                    "evidence": [],
                    "extensions": {},
                },
            },
            "final",
        ),
    ],
)
async def test_runner_emits_exactly_one_v2_turn_terminal(
    turn,
    terminal_type: str,
) -> None:
    stdout = io.StringIO()
    stderr = io.StringIO()

    async def fake_execute(_request):
        return turn

    result = await run(
        parse_request(valid_request_v3()),
        execute=fake_execute,
        stdout=stdout,
        stderr=stderr,
    )

    assert result == 0
    records = [json.loads(line) for line in stdout.getvalue().splitlines()]
    assert [record["protocol"] for record in records] == [
        "workfabric.agent-runtime/3",
        "workfabric.agent-runtime/3",
        "workfabric.agent-runtime/3",
    ]
    assert records[-1]["type"] == terminal_type


@pytest.mark.asyncio
async def test_runner_keeps_diagnostics_off_stdout_and_emits_completed_record() -> None:
    stdout = io.StringIO()
    stderr = io.StringIO()

    async def fake_execute(_request):
        return {
            "request_summary": "summary",
            "response": "response",
            "missing_information": [],
            "handoff_draft_required": False,
            "handoff_draft_reason": "no handoff needed",
            "handoff_draft_capability": "",
            "handoff_draft_intent": "",
            "handoff_draft_acceptance_criteria": [],
        }

    result = await run(parse_request(valid_request()), execute=fake_execute, stdout=stdout, stderr=stderr)

    assert result == 0
    records = stdout.getvalue().splitlines()
    assert len(records) == 3
    assert '"type":"progress"' in records[0]
    assert '"type":"progress"' in records[1]
    assert '"type":"completed"' in records[2]
    assert stderr.getvalue() == ""


@pytest.mark.asyncio
async def test_runner_safely_reports_execution_errors_without_secret_or_prompt() -> None:
    stdout = io.StringIO()
    stderr = io.StringIO()
    secret = "super-secret-token"

    async def fake_execute(_request):
        raise RuntimeError(f"request failed with {secret} and private prompt")

    result = await run(parse_request(valid_request()), execute=fake_execute, stdout=stdout, stderr=stderr, secrets=(secret,))

    assert result == 1
    assert '"type":"failed"' in stdout.getvalue()
    assert secret not in stdout.getvalue()
    assert secret not in stderr.getvalue()
    assert "private prompt" not in stderr.getvalue()


@pytest.mark.asyncio
async def test_runner_fails_closed_when_model_output_contains_the_environment_secret() -> None:
    stdout = io.StringIO()
    stderr = io.StringIO()
    secret = "super-secret-token"

    async def fake_execute(_request):
        return {
            "request_summary": "summary",
            "response": f"response {secret}",
            "missing_information": [],
            "handoff_draft_required": False,
            "handoff_draft_reason": "no handoff needed",
            "handoff_draft_capability": "",
            "handoff_draft_intent": "",
            "handoff_draft_acceptance_criteria": [],
        }

    result = await run(parse_request(valid_request()), execute=fake_execute, stdout=stdout, stderr=stderr, secrets=(secret,))

    assert result == 1
    assert '"type":"completed"' not in stdout.getvalue()
    assert '"type":"failed"' in stdout.getvalue()
    assert secret not in stdout.getvalue()


@pytest.mark.asyncio
async def test_runner_rejects_a_task_that_contains_the_environment_secret_before_execution() -> None:
    stdout = io.StringIO()
    stderr = io.StringIO()
    secret = "super-secret-token"
    value = valid_request()
    value["task"]["authority_scope"] = {"delegation": {"value": secret}}
    called = False

    async def fake_execute(_request):
        nonlocal called
        called = True
        raise AssertionError("executor must not run")

    result = await run(parse_request(value), execute=fake_execute, stdout=stdout, stderr=stderr, secrets=(secret,))

    assert result == 1
    assert called is False
    assert '"type":"failed"' in stdout.getvalue()
    assert secret not in stdout.getvalue()


def test_real_agently_refusal_never_contaminates_protocol_stdout() -> None:
    value = valid_request()
    value["provider"]["base_url"] = "http://127.0.0.1:1/v1"
    environment = {**os.environ, "AGENTLY_MODEL_API_KEY": "test-key"}

    completed = subprocess.run(
        [sys.executable, "-m", "work_fabric_agently_runtime"],
        input=json.dumps(value, separators=(",", ":")) + "\n",
        text=True,
        capture_output=True,
        env=environment,
        timeout=20,
        check=False,
    )

    assert completed.returncode == 1
    lines = completed.stdout.splitlines()
    assert lines
    assert all(json.loads(line)["protocol"] == "workfabric.agent-runtime/1" for line in lines)
    assert "[WARNING]" not in completed.stdout
    assert "[ERROR]" not in completed.stdout
