from __future__ import annotations

import pytest

from work_fabric_agently_runtime.assistant import (
    ASSISTANT_OUTPUT_SCHEMA,
    AssistantOutputError,
    execute_with_agent,
    role_prompt,
    task_prompt_input,
)
from work_fabric_agently_runtime.protocol import parse_request

from .conftest import valid_request


class FakeAgent:
    def use_workspace(self, path: str) -> "FakeAgent":
        self.workspace = path
        return self

    def role(self, value: str, *, always: bool) -> "FakeAgent":
        self.role_value = value
        assert always is True
        return self

    def input(self, value: object) -> "FakeAgent":
        self.input_value = value
        return self

    def output(self, schema: object, *, format: str) -> "FakeAgent":
        self.schema = schema
        assert format == "json"
        return self

    async def async_start(self) -> object:
        return {
            "request_summary": "整理后的请求",
            "response": "已收到并完成整理",
            "missing_information": [],
            "handoff_draft_required": True,
            "handoff_draft_reason": "需要需求分析角色继续处理",
            "handoff_draft_capability": "requirements.analysis",
            "handoff_draft_intent": "梳理并确认需求",
            "handoff_draft_acceptance_criteria": ["范围得到确认"],
        }


@pytest.mark.asyncio
async def test_executes_a_single_structured_request_in_the_supplied_workspace() -> None:
    request = parse_request(valid_request())
    agent = FakeAgent()

    output = await execute_with_agent(request, agent)

    assert agent.workspace == request.task["workspace_path"]
    assert agent.role_value == role_prompt(request.task["role"])
    assert agent.input_value == task_prompt_input(request.task)
    assert agent.schema == ASSISTANT_OUTPUT_SCHEMA
    assert output["response"] == "已收到并完成整理"
    assert "workspace_path" not in agent.input_value
    assert agent.input_value["context_reference"] == {"reference": "handoff-context-1"}


@pytest.mark.asyncio
async def test_rejects_invalid_handoff_draft_from_the_model() -> None:
    request = parse_request(valid_request())
    agent = FakeAgent()

    async def invalid_start() -> object:
        return {
            "request_summary": "summary",
            "response": "response",
            "missing_information": [],
            "handoff_draft_required": True,
            "handoff_draft_reason": "reason",
            "handoff_draft_capability": "not-valid",
            "handoff_draft_intent": "intent",
            "handoff_draft_acceptance_criteria": ["criterion"],
        }

    agent.async_start = invalid_start  # type: ignore[method-assign]
    with pytest.raises(AssistantOutputError, match="capability"):
        await execute_with_agent(request, agent)
