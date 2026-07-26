from __future__ import annotations

import io

import pytest

from work_fabric_agently_runtime.protocol import parse_request
from work_fabric_agently_runtime.runner import run

from .conftest import valid_request


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
