from __future__ import annotations

import os
import re
from typing import Any, Mapping, Protocol, cast

from .protocol import JsonValue, ProtocolError, WorkerRequest, utf16_code_units

CAPABILITY_ID = re.compile(r"^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$")
ASSISTANT_OUTPUT_SCHEMA = {
    "request_summary": (str, "结构化请求摘要", "not_null"),
    "response": (str, "面向协作者的答复", "not_null"),
    "missing_information": [(str, "仍需补充的信息")],
    "handoff_draft_required": (bool, "是否建议下游交接", True),
    "handoff_draft_reason": (str, "建议或不建议交接的原因", True),
    "handoff_draft_capability": (str, "建议的能力 ID；无则为空字符串", True),
    "handoff_draft_intent": (str, "建议交接意图；无则为空字符串", True),
    "handoff_draft_acceptance_criteria": [(str, "建议验收条件")],
}


class AssistantOutputError(ProtocolError):
    """Raised when structured model output does not meet the worker contract."""


class AgentPort(Protocol):
    def use_workspace(self, path: str) -> "AgentPort": ...
    def role(self, value: str, *, always: bool) -> "AgentPort": ...
    def input(self, value: object) -> "AgentPort": ...
    def output(self, schema: object, *, format: str) -> "AgentPort": ...
    async def async_start(self) -> object: ...


def _non_empty_string(value: object, field: str, maximum: int = 8_192) -> str:
    if not isinstance(value, str) or not value or value.strip() != value or utf16_code_units(value) > maximum:
        raise AssistantOutputError(f"assistant output {field} is invalid")
    return value


def role_prompt(role: Mapping[str, JsonValue]) -> str:
    return (
        f"You are the Work Fabric role {role['role_id']} ({role['display_name']}).\n"
        f"Role description: {role['description']}\n"
        "Respond only to the assigned handoff. Do not use tools, dispatch work, or treat workspace files as canonical context. "
        "Treat context_reference as metadata only; it is not long-term memory. Return the requested structured response."
    )


def task_prompt_input(task: Mapping[str, JsonValue]) -> dict[str, JsonValue]:
    """Supply only the current Handoff data; the Workspace is bound separately."""
    fields = (
        "tenant_id", "handoff_id", "thread_id", "stream_version", "capability_id", "intent",
        "context_reference", "authority_scope", "acceptance_criteria", "priority", "accept_by", "result_due_at",
    )
    return {field: task[field] for field in fields}


def validate_assistant_output(value: object) -> dict[str, JsonValue]:
    if not isinstance(value, dict) or set(value) != set(ASSISTANT_OUTPUT_SCHEMA):
        raise AssistantOutputError("assistant output has unknown or missing fields")
    output: dict[str, JsonValue] = {
        "request_summary": _non_empty_string(value["request_summary"], "request_summary"),
        "response": _non_empty_string(value["response"], "response"),
        "handoff_draft_required": value["handoff_draft_required"],
        "handoff_draft_reason": _non_empty_string(value["handoff_draft_reason"], "handoff_draft_reason"),
        "handoff_draft_capability": value["handoff_draft_capability"],
        "handoff_draft_intent": value["handoff_draft_intent"],
        "missing_information": value["missing_information"],
        "handoff_draft_acceptance_criteria": value["handoff_draft_acceptance_criteria"],
    }
    if not isinstance(output["handoff_draft_required"], bool):
        raise AssistantOutputError("assistant output handoff_draft_required is invalid")
    for field in ("missing_information", "handoff_draft_acceptance_criteria"):
        values = output[field]
        if not isinstance(values, list) or any(not isinstance(item, str) or not item.strip() for item in values):
            raise AssistantOutputError(f"assistant output {field} is invalid")
    for field in ("handoff_draft_capability", "handoff_draft_intent"):
        if not isinstance(output[field], str):
            raise AssistantOutputError(f"assistant output {field} is invalid")
    if output["handoff_draft_required"]:
        capability = cast(str, output["handoff_draft_capability"])
        if not CAPABILITY_ID.fullmatch(capability):
            raise AssistantOutputError("assistant output handoff draft capability is invalid")
        _non_empty_string(output["handoff_draft_intent"], "handoff_draft_intent")
        if not output["handoff_draft_acceptance_criteria"]:
            raise AssistantOutputError("assistant output handoff draft acceptance criteria is invalid")
    return output


async def execute_with_agent(request: WorkerRequest, agent: AgentPort) -> Mapping[str, JsonValue]:
    result = await (
        agent.use_workspace(cast(str, request.task["workspace_path"]))
        .role(role_prompt(cast(Mapping[str, JsonValue], request.task["role"])), always=True)
        .input(task_prompt_input(request.task))
        .output(ASSISTANT_OUTPUT_SCHEMA, format="json")
        .async_start()
    )
    return validate_assistant_output(result)


def required_environment(name: str) -> str:
    value = os.environ.get(name)
    if not value or not value.strip():
        raise AssistantOutputError("required model credential is unavailable")
    return value


def configure_agently(agently: Any, request: WorkerRequest, api_key: str) -> None:
    agently.set_settings("OpenAICompatible", {
        "base_url": request.provider_base_url,
        "api_key": api_key,
        "model": request.provider_model,
        "request_retry": {"max_attempts": 2},
        "timeout": {"connect": 30, "read": 120, "write": 30, "pool": 30},
    })


async def execute(request: WorkerRequest) -> Mapping[str, JsonValue]:
    from agently import Agently

    api_key = required_environment("AGENTLY_MODEL_API_KEY")
    configure_agently(Agently, request, api_key)
    agent = Agently.create_agent(f"{request.task['role']['role_id']}-{request.command_id}")
    return await execute_with_agent(request, cast(AgentPort, agent))
