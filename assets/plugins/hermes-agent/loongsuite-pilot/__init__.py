"""Native Hermes Agent event collector for LoongSuite Pilot."""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import socket
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional


AGENT_TYPE = "hermes"
HOOKS = (
    "on_session_start",
    "pre_llm_call",
    "pre_api_request",
    "post_api_request",
    "api_request_error",
    "pre_tool_call",
    "post_tool_call",
    "post_llm_call",
    "on_session_end",
    "on_session_finalize",
)
MAX_SESSIONS = 100
MAX_TURN_MESSAGES = 64
MAX_PARTS = 64
MAX_COLLECTION_ITEMS = 128
MAX_CONTENT_CHARS = 32 * 1024
MAX_VALUE_DEPTH = 8
MAX_RESOURCE_FIELD_VALUE_LENGTH = 512
LOG_RETENTION_SECONDS = 7 * 24 * 60 * 60
MANAGED_MARKER_FILE = ".loongsuite-pilot-managed.json"
INVOCATION_USER_ID_FIELD = "agent.pilot.invocation.user.id"

_PROCESS_FILE_TOKEN = "%s-%s-%s" % (
    os.getpid(),
    time.time_ns(),
    secrets.token_hex(4),
)
_STATE_LOCK = threading.RLock()
_SESSIONS: Dict[str, Dict[str, Any]] = {}


def _read_json_object(path: Path) -> Dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def _default_data_dir() -> Path:
    return Path.home() / ".loongsuite-pilot"


def _managed_data_dir() -> Optional[Path]:
    marker = _read_json_object(Path(__file__).resolve().parent / MANAGED_MARKER_FILE)
    configured = marker.get("dataDir")
    if isinstance(configured, str) and configured:
        return Path(configured).expanduser()
    return None


def _config_path() -> Path:
    configured = os.environ.get("AGENT_DATA_COLLECTION_CONFIG")
    if configured:
        return Path(configured).expanduser()
    environment_data_dir = os.environ.get("LOONGSUITE_PILOT_DATA_DIR")
    if environment_data_dir:
        return Path(environment_data_dir).expanduser() / "config.json"
    managed_data_dir = _managed_data_dir()
    if managed_data_dir:
        managed_config = managed_data_dir / "config.json"
        if managed_config.is_file():
            return managed_config
    return _default_data_dir() / "config.json"


def _data_dir() -> Path:
    configured = os.environ.get("LOONGSUITE_PILOT_DATA_DIR")
    if configured:
        return Path(configured).expanduser()
    managed_data_dir = _managed_data_dir()
    if managed_data_dir:
        return managed_data_dir
    config_data_dir = _read_json_object(_config_path()).get("dataDir")
    if isinstance(config_data_dir, str) and config_data_dir:
        return Path(config_data_dir).expanduser()
    return _default_data_dir()


def _config() -> Dict[str, Any]:
    return _read_json_object(_config_path())


def _report_internal_error(operation: str, error: Exception) -> None:
    print(
        "[loongsuite-pilot] %s failed: %s" % (operation, type(error).__name__),
        file=sys.stderr,
    )


def _capture_message_content(config: Dict[str, Any]) -> bool:
    agents = config.get("agents")
    if not isinstance(agents, dict):
        return True
    agent_config = agents.get("hermes-agent")
    if not isinstance(agent_config, dict):
        agent_config = agents.get("hermes")
    if not isinstance(agent_config, dict):
        return True
    value = agent_config.get("captureMessageContent")
    if value is False:
        return False
    return not (isinstance(value, str) and value.strip().lower() == "false")


def _hostname() -> str:
    try:
        return socket.gethostname() or "unknown"
    except Exception:
        return "unknown"


def _normalized_identity(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    if not normalized or len(normalized) > MAX_RESOURCE_FIELD_VALUE_LENGTH:
        return None
    return normalized


def _invocation_user_id() -> Optional[str]:
    raw = os.environ.get("LOONGSUITE_PILOT_SPAN_ATTRIBUTES")
    if not isinstance(raw, str) or not raw:
        return None
    resolved = None
    for pair in raw.split(","):
        key, separator, value = pair.partition("=")
        if separator and key.strip() == "gen_ai.user.id":
            candidate = _normalized_identity(value)
            if candidate:
                resolved = candidate
    return resolved


def _resolve_user_identity(sender_id: Any, config: Dict[str, Any]) -> Dict[str, str]:
    invocation_user = _invocation_user_id()
    if invocation_user:
        return {"user_id": invocation_user, "source": "invocation"}
    env_user = (
        os.environ.get("LOONGSUITE_PILOT_USER_ID")
        or os.environ.get("LOONGSUITE_USER_ID")
    )
    normalized_env_user = _normalized_identity(env_user)
    if normalized_env_user:
        return {"user_id": normalized_env_user, "source": "environment"}
    normalized_sender_id = _normalized_identity(sender_id)
    if normalized_sender_id:
        return {"user_id": normalized_sender_id, "source": "sender"}
    config_user = _normalized_identity(config.get("userId"))
    if config_user:
        return {"user_id": config_user, "source": "config"}
    return {"user_id": _hostname(), "source": "hostname"}

def _worker_name() -> Optional[str]:
    raw = os.environ.get("AGENTTEAMS_WORKER_NAME")
    if raw is None:
        return None
    value = raw.strip()
    if not value or len(value) > MAX_RESOURCE_FIELD_VALUE_LENGTH:
        return None
    return value


def _truncate(value: str) -> str:
    if len(value) <= MAX_CONTENT_CHARS:
        return value
    return value[:MAX_CONTENT_CHARS] + "...[truncated]"


def _bounded_value(value: Any, depth: int = 0) -> Any:
    if depth >= MAX_VALUE_DEPTH:
        return "[max-depth]"
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return _truncate(value)
    if isinstance(value, (list, tuple)):
        return [
            _bounded_value(item, depth + 1)
            for item in list(value)[:MAX_COLLECTION_ITEMS]
        ]
    if isinstance(value, dict):
        output: Dict[str, Any] = {}
        for key, item in list(value.items())[:MAX_COLLECTION_ITEMS]:
            output[_truncate(str(key))] = _bounded_value(item, depth + 1)
        return output
    return _truncate(str(value))


def _decode_json(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except Exception:
        return value


def _json_object(value: Any) -> Dict[str, Any]:
    decoded = _decode_json(value)
    return decoded if isinstance(decoded, dict) else {}


def _tool_definition(value: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(value, dict):
        return None

    definition = value
    nested = value.get("function")
    if not isinstance(nested, dict):
        nested = value.get("toolSpec")
    if isinstance(nested, dict):
        definition = nested

    name = definition.get("name")
    if not isinstance(name, str) or not name.strip():
        return None
    name = name.strip()

    tool_type = value.get("type")
    if not isinstance(tool_type, str) or not tool_type:
        tool_type = "function"
    output: Dict[str, Any] = {
        "type": _truncate(tool_type),
        "name": _truncate(name),
    }

    description = definition.get("description")
    if isinstance(description, str):
        output["description"] = _truncate(description)

    parameters: Any = None
    for key in ("parameters", "input_schema", "inputSchema"):
        if key in definition:
            parameters = definition.get(key)
            break
    if isinstance(parameters, dict) and set(parameters) == {"json"}:
        parameters = parameters.get("json")
    if parameters is not None:
        output["parameters"] = _bounded_value(parameters)
    return output


def _tool_definitions(request: Any) -> List[Dict[str, Any]]:
    if not isinstance(request, dict):
        return []
    body = request.get("body")
    if not isinstance(body, dict):
        return []

    tools = body.get("tools")
    if not isinstance(tools, list):
        tool_config = body.get("toolConfig") or body.get("tool_config")
        tools = tool_config.get("tools") if isinstance(tool_config, dict) else None
    if not isinstance(tools, list):
        return []

    output: List[Dict[str, Any]] = []
    for value in tools[:MAX_COLLECTION_ITEMS]:
        definition = _tool_definition(value)
        if definition is not None:
            output.append(definition)
    return output


def _text_parts(value: Any) -> List[Dict[str, str]]:
    """Normalize a provider text payload (str / block list / nested parts) into text parts."""
    if isinstance(value, str):
        blocks: List[Any] = [value]
    elif isinstance(value, dict):
        # Gemini nests the prompt under systemInstruction.parts[].text.
        nested = value.get("parts")
        blocks = nested if isinstance(nested, list) else [value]
    elif isinstance(value, list):
        blocks = value
    else:
        return []

    parts: List[Dict[str, str]] = []
    for block in blocks[:MAX_PARTS]:
        if isinstance(block, str):
            text: Any = block
        elif isinstance(block, dict):
            # Anthropic/Bedrock blocks use "text"; OpenAI-style ones use "content".
            text = block.get("text")
            if not isinstance(text, str):
                text = block.get("content")
        else:
            text = None
        if isinstance(text, str) and text.strip():
            parts.append({"type": "text", "content": _truncate(text)})
    return parts


def _system_instructions(request: Any) -> List[Dict[str, str]]:
    """Extract the system prompt from a provider request body.

    Hermes never replays system messages through conversation_history, so the
    request body built for the provider is the only place the prompt is
    observable. Shapes differ per provider: Anthropic/Bedrock keep it in a
    top-level "system" field, Responses uses top-level "instructions", Gemini
    nests it under systemInstruction.parts, and OpenAI-compatible providers
    carry it as leading system/developer messages.
    """
    if not isinstance(request, dict):
        return []
    body = request.get("body")
    if not isinstance(body, dict):
        return []

    for key in ("system", "instructions", "systemInstruction", "system_instruction"):
        if key in body:
            parts = _text_parts(body.get(key))
            if parts:
                return parts

    messages = body.get("messages")
    if not isinstance(messages, list):
        return []
    parts = []
    for message in messages[:MAX_TURN_MESSAGES]:
        if not isinstance(message, dict):
            continue
        if message.get("role") not in ("system", "developer"):
            continue
        parts.extend(_text_parts(message.get("content")))
        if len(parts) >= MAX_PARTS:
            break
    return parts[:MAX_PARTS]


def _skill_attributes(
    tool_name: Any,
    arguments: Any = None,
    result: Any = None,
) -> Dict[str, str]:
    if tool_name not in ("skill_view", "skill_manage"):
        return {}

    argument_data = _json_object(arguments)
    result_data = _json_object(result)
    if result_data.get("success") is False:
        result_data = {}
    metadata = result_data.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}
    hermes_metadata = metadata.get("hermes")
    if not isinstance(hermes_metadata, dict):
        hermes_metadata = {}

    skill_name = result_data.get("name") or argument_data.get("name")
    skill_id = (
        result_data.get("id")
        or metadata.get("id")
        or hermes_metadata.get("id")
        or skill_name
    )
    skill_description = result_data.get("description")
    skill_version = (
        result_data.get("version")
        or metadata.get("version")
        or hermes_metadata.get("version")
    )
    fields: Dict[str, str] = {}
    for key, value in (
        ("gen_ai.skill.name", skill_name),
        ("gen_ai.skill.id", skill_id),
        ("gen_ai.skill.description", skill_description),
        ("gen_ai.skill.version", skill_version),
    ):
        if value not in (None, ""):
            fields[key] = _truncate(str(value))
    return fields


def _new_trace_id() -> str:
    return secrets.token_hex(16)


def _new_span_id() -> str:
    return secrets.token_hex(8)


def _new_event_id() -> str:
    return str(uuid.uuid4())


def _session(session_id: str) -> Dict[str, Any]:
    state = _SESSIONS.get(session_id)
    if state is None:
        state = {
            "model": None,
            "platform": None,
            "current_turn": None,
        }
        _SESSIONS[session_id] = state
        while len(_SESSIONS) > MAX_SESSIONS:
            oldest = next(
                (
                    candidate
                    for candidate, candidate_state in _SESSIONS.items()
                    if candidate != session_id and candidate_state.get("current_turn") is None
                ),
                next(iter(_SESSIONS)),
            )
            evicted = _SESSIONS.pop(oldest, None)
            turn = evicted.get("current_turn") if evicted else None
            if turn and any(api.get("post_ns") is not None for api in turn["apis"]):
                try:
                    evicted["current_turn"] = None
                    _write_records(_build_records(turn, evicted, {}))
                except Exception as error:
                    _report_internal_error("session eviction flush", error)
    else:
        _SESSIONS.pop(session_id, None)
        _SESSIONS[session_id] = state
    return state


def _new_turn(
    session_id: str,
    user_message: Any = "",
    history_length: int = 1,
    sender_id: Any = "",
    observer_turn_id: Any = "",
) -> Dict[str, Any]:
    config = _config()
    normalized_sender_id = _normalized_identity(sender_id)
    user_identity = _resolve_user_identity(normalized_sender_id, config)
    return {
        "session_id": session_id,
        "task_id": None,
        "observer_turn_id": (
            observer_turn_id if isinstance(observer_turn_id, str) and observer_turn_id else None
        ),
        "fallback_turn_id": "%s:%s" % (session_id, uuid.uuid4()),
        "trace_id": _new_trace_id(),
        "user_id": user_identity["user_id"],
        "user_id_source": user_identity["source"],
        "sender_id": normalized_sender_id,
        "capture_content": _capture_message_content(config),
        "user_message": user_message if isinstance(user_message, str) else str(user_message or ""),
        "history_length": max(1, history_length),
        "apis": [],
        "tools": {},
    }


def _turn_id(turn: Dict[str, Any]) -> str:
    observer_turn_id = turn.get("observer_turn_id")
    if isinstance(observer_turn_id, str) and observer_turn_id:
        return observer_turn_id
    task_id = turn.get("task_id")
    return task_id if isinstance(task_id, str) and task_id else turn["fallback_turn_id"]


def _provider_name(value: Any) -> str:
    provider = str(value or "unknown").strip().lower().replace("_", ".")
    aliases = {
        "alibaba": "qwen",
        "aliyun": "qwen",
        "dashscope": "qwen",
        "google": "gcp.gemini",
        "gemini": "gcp.gemini",
        "vertex": "gcp.vertex_ai",
        "vertex.ai": "gcp.vertex_ai",
        "azure": "azure.ai.openai",
        "bedrock": "aws.bedrock",
    }
    return aliases.get(provider, provider or "unknown")


def _numeric(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and value >= 0:
        return int(value)
    return None


def _tool_calls(message: Dict[str, Any], capture_content: bool) -> List[Dict[str, Any]]:
    output: List[Dict[str, Any]] = []
    calls = message.get("tool_calls")
    if not isinstance(calls, list):
        return output
    for call in calls[:MAX_PARTS]:
        if not isinstance(call, dict):
            continue
        function = call.get("function") if isinstance(call.get("function"), dict) else {}
        call_id = call.get("id") or call.get("call_id")
        name = function.get("name") or call.get("name") or "unknown"
        part: Dict[str, Any] = {
            "type": "tool_call",
            "id": str(call_id) if call_id else None,
            "name": str(name),
        }
        if capture_content and "arguments" in function:
            part["arguments"] = _bounded_value(_decode_json(function.get("arguments")))
        output.append(part)
    return output


def _message(message: Any, capture_content: bool) -> Optional[Dict[str, Any]]:
    if not isinstance(message, dict):
        return None
    role = str(message.get("role") or "unknown")
    parts: List[Dict[str, Any]] = []
    content = message.get("content")

    if role == "tool":
        call_id = message.get("tool_call_id") or message.get("call_id")
        response = _bounded_value(_decode_json(content)) if capture_content else ""
        parts.append({
            "type": "tool_call_response",
            "id": str(call_id) if call_id else None,
            "response": response,
        })
    else:
        if isinstance(content, str):
            if content or not message.get("tool_calls"):
                parts.append({"type": "text", "content": _truncate(content) if capture_content else ""})
        elif isinstance(content, list):
            for item in content[:MAX_PARTS]:
                if isinstance(item, dict) and item.get("type") in ("text", "input_text", "output_text"):
                    text = item.get("text", item.get("content", ""))
                    parts.append({
                        "type": "text",
                        "content": _truncate(str(text or "")) if capture_content else "",
                    })
        elif content is not None:
            parts.append({
                "type": "text",
                "content": _truncate(str(content)) if capture_content else "",
            })
        parts.extend(_tool_calls(message, capture_content))

    if not parts:
        parts.append({"type": "text", "content": ""})
    output: Dict[str, Any] = {"role": role, "parts": parts[:MAX_PARTS]}
    finish_reason = message.get("finish_reason")
    if isinstance(finish_reason, str) and finish_reason:
        output["finish_reason"] = finish_reason
    return output


def _messages(messages: List[Any], capture_content: bool) -> List[Dict[str, Any]]:
    output: List[Dict[str, Any]] = []
    for item in messages[-MAX_TURN_MESSAGES:]:
        converted = _message(item, capture_content)
        if converted is not None:
            output.append(converted)
    return output


def _current_turn_messages(turn: Dict[str, Any], payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    history = payload.get("conversation_history")
    if not isinstance(history, list):
        history = []
    start = max(0, int(turn.get("history_length") or 1) - 1)
    current = [item for item in history[start:] if isinstance(item, dict)]
    if not current:
        current = [{"role": "user", "content": turn.get("user_message", "")}]
        response = payload.get("assistant_response")
        if response is not None:
            current.append({"role": "assistant", "content": response, "finish_reason": "stop"})
    elif current[0].get("role") != "user" and turn.get("user_message"):
        current.insert(0, {"role": "user", "content": turn["user_message"]})
    if len(current) > MAX_TURN_MESSAGES:
        current = [current[0]] + current[-(MAX_TURN_MESSAGES - 1):]
    return current


def _common_fields(
    turn: Dict[str, Any],
    session_state: Dict[str, Any],
    event_name: str,
    timestamp_ns: int,
    step_id: str,
    span_id: str,
) -> Dict[str, Any]:
    platform = session_state.get("platform") or "cli"
    fields: Dict[str, Any] = {
        "time_unix_nano": str(timestamp_ns),
        "observed_time_unix_nano": str(timestamp_ns),
        "event.id": _new_event_id(),
        "event.name": event_name,
        "trace_id": turn["trace_id"],
        "span_id": span_id,
        "user.id": turn["user_id"],
        "host.name": _hostname(),
        "service.name": "hermes-agent",
        "agent.channel": str(platform),
        "gen_ai.session.id": turn["session_id"],
        "gen_ai.turn.id": _turn_id(turn),
        "gen_ai.step.id": step_id,
        "gen_ai.agent.type": AGENT_TYPE,
    }
    if turn.get("user_id_source") in ("invocation", "environment", "sender"):
        fields[INVOCATION_USER_ID_FIELD] = turn["user_id"]
    if turn.get("sender_id"):
        fields["agent.hermes.sender.id"] = turn["sender_id"]
    worker_name = _worker_name()
    if worker_name:
        fields["gen_ai.agent.name"] = worker_name
        fields["resourceAttributes"] = {
            "agentteams.worker.name": worker_name,
        }
    return fields


def _usage_fields(payload: Dict[str, Any]) -> Dict[str, int]:
    usage = payload.get("usage")
    if not isinstance(usage, dict):
        return {}
    input_tokens = _numeric(usage.get("prompt_tokens"))
    if input_tokens is None:
        input_tokens = _numeric(usage.get("input_tokens"))
    output_tokens = _numeric(usage.get("output_tokens"))
    cache_read = _numeric(usage.get("cache_read_tokens"))
    cache_write = _numeric(usage.get("cache_write_tokens"))
    total_tokens = _numeric(usage.get("total_tokens"))
    if total_tokens is None and input_tokens is not None and output_tokens is not None:
        total_tokens = input_tokens + output_tokens
    fields: Dict[str, int] = {}
    mappings = (
        ("gen_ai.usage.input_tokens", input_tokens),
        ("gen_ai.usage.output_tokens", output_tokens),
        ("gen_ai.usage.cache_read.input_tokens", cache_read),
        ("gen_ai.usage.cache_creation.input_tokens", cache_write),
        ("gen_ai.usage.total_tokens", total_tokens),
    )
    for name, value in mappings:
        if value is not None:
            fields[name] = value
    return fields


def _tool_status(result: Any, explicit_status: Any = None) -> str:
    if isinstance(explicit_status, str):
        status = explicit_status.strip().lower()
        if status == "ok":
            return "success"
        if status in ("success", "error", "blocked", "cancelled"):
            return status
    decoded = _decode_json(result)
    if isinstance(decoded, dict) and decoded.get("error") not in (None, "", False):
        return "error"
    return "success"


def _match_api(
    turn: Dict[str, Any],
    task_id: Any,
    api_call_count: Any,
    require_open: bool,
    api_request_id: Any = None,
) -> Optional[Dict[str, Any]]:
    for api in reversed(turn["apis"]):
        if api_request_id and api.get("api_request_id") != api_request_id:
            continue
        if task_id and api.get("task_id") != task_id:
            continue
        if api_call_count is not None and api.get("api_call_count") != api_call_count:
            continue
        if require_open and api.get("post_ns") is not None:
            continue
        return api
    return None


def _build_records(
    turn: Dict[str, Any],
    session_state: Dict[str, Any],
    payload: Dict[str, Any],
) -> List[Dict[str, Any]]:
    apis = [api for api in turn["apis"] if api.get("post_ns") is not None]
    if not apis:
        return []
    current_messages = _current_turn_messages(turn, payload)
    assistant_positions = [
        index for index, message in enumerate(current_messages)
        if message.get("role") == "assistant"
    ]
    capture = bool(turn["capture_content"])
    turn_id = _turn_id(turn)
    records: List[Dict[str, Any]] = []
    tool_step: Dict[str, int] = {}

    previous_assistant_position: Optional[int] = None
    assistant_cursor = 0
    for index, api in enumerate(apis):
        step_number = index + 1
        step_id = "%s:s%s" % (turn_id, step_number)
        span_id = _new_span_id()
        response_id = "%s:r" % step_id
        post = api.get("post") or {}
        is_error = bool(post.get("error_type"))
        assistant_position: Optional[int] = None
        if not is_error and assistant_cursor < len(assistant_positions):
            assistant_position = assistant_positions[assistant_cursor]
            assistant_cursor += 1

        if is_error:
            input_end = (
                assistant_positions[assistant_cursor]
                if assistant_cursor < len(assistant_positions)
                else len(current_messages)
            )
            assistant_message = {
                "role": "assistant",
                "content": "",
                "finish_reason": post.get("finish_reason") or "error",
            }
            input_source = current_messages[:input_end]
            delta_start = 0 if previous_assistant_position is None else previous_assistant_position
            delta_source = current_messages[delta_start:input_end]
        elif assistant_position is None:
            assistant_message: Dict[str, Any] = {
                "role": "assistant",
                "content": payload.get("assistant_response", "") if index == len(apis) - 1 else "",
                "finish_reason": post.get("finish_reason") or "stop",
            }
            input_source = current_messages if index == 0 else []
            delta_source = input_source
        else:
            assistant_message = current_messages[assistant_position]
            input_source = current_messages[:assistant_position]
            delta_start = 0 if previous_assistant_position is None else previous_assistant_position
            delta_source = current_messages[delta_start:assistant_position]
            previous_assistant_position = assistant_position

        for call in _tool_calls(assistant_message, capture):
            call_id = call.get("id")
            if call_id:
                tool_step[str(call_id)] = index

        pre = api.get("pre") or {}
        tool_definitions = pre.get("tool_definitions")
        system_instructions = pre.get("system_instructions")
        # System instructions are provider configuration, not turn messages.
        # Keep them in their dedicated field so they do not alter the existing
        # input, delta, or input-hash semantics.
        input_messages = _messages(input_source, capture)
        input_delta = _messages(delta_source, capture)
        output_message = _message(assistant_message, capture)
        provider = _provider_name(post.get("provider") or pre.get("provider"))
        request_model = str(pre.get("model") or post.get("model") or session_state.get("model") or "unknown")
        response_model = str(post.get("response_model") or post.get("model") or request_model)
        request_id = api.get("api_request_id") or "%s:a%s" % (
            turn_id, api.get("api_call_count") or step_number
        )

        request = _common_fields(
            turn, session_state, "llm.request", int(api["pre_ns"]), step_id, span_id
        )
        request.update({
            "gen_ai.provider.name": provider,
            "gen_ai.request.id": request_id,
            "gen_ai.response.id": response_id,
            "gen_ai.request.model": request_model,
            "gen_ai.input.messages": input_messages,
            "gen_ai.input.messages_delta": input_delta,
            "gen_ai.input.messages_hash": hashlib.sha256(
                json.dumps(input_messages, sort_keys=True, separators=(",", ":")).encode("utf-8")
            ).hexdigest(),
        })
        if isinstance(tool_definitions, list) and tool_definitions:
            request["gen_ai.tool.definitions"] = tool_definitions
        if isinstance(system_instructions, list) and system_instructions:
            request["gen_ai.system_instructions"] = system_instructions
        records.append(request)

        finish_reason = str(post.get("finish_reason") or assistant_message.get("finish_reason") or "stop")
        if output_message is None:
            output_message = {"role": "assistant", "parts": [{"type": "text", "content": ""}]}
        output_message["finish_reason"] = finish_reason
        response = _common_fields(
            turn, session_state, "llm.response", int(api["post_ns"]), step_id, span_id
        )
        response.update({
            "gen_ai.provider.name": provider,
            "gen_ai.request.id": request_id,
            "gen_ai.response.id": response_id,
            "gen_ai.request.model": request_model,
            "gen_ai.response.model": response_model,
            "gen_ai.response.finish_reasons": [finish_reason],
            "gen_ai.output.messages": [output_message],
        })
        error_type = post.get("error_type")
        if error_type:
            response["error.type"] = str(error_type)
            response["error.message"] = (
                str(post.get("error_message") or "provider request failed")
                if capture
                else "provider request failed"
            )
            status_code = _numeric(post.get("status_code"))
            if status_code is not None:
                response["http.status_code"] = status_code
        response.update(_usage_fields(post))
        records.append(response)

    for call_id, tool in turn["tools"].items():
        if tool.get("end_ns") is None:
            continue
        api_index = tool_step.get(call_id)
        if api_index is None:
            api_index = 0
            for index, api in enumerate(apis):
                if int(api["post_ns"]) <= int(tool["start_ns"]):
                    api_index = index
        api_index = min(api_index, len(apis) - 1)
        step_id = "%s:s%s" % (turn_id, api_index + 1)
        span_id = _new_span_id()
        tool_name = str(tool.get("tool_name") or "unknown")
        call = _common_fields(
            turn, session_state, "tool.call", int(tool["start_ns"]), step_id, span_id
        )
        call.update({
            "gen_ai.provider.name": _provider_name(
                (apis[api_index].get("post") or {}).get("provider")
                or (apis[api_index].get("pre") or {}).get("provider")
            ),
            "gen_ai.tool.name": tool_name,
            "gen_ai.tool.call.id": call_id,
            "gen_ai.tool.call.exec.id": call_id,
        })
        if capture and "args" in tool:
            call["gen_ai.tool.call.arguments"] = tool["args"]
        call.update(tool.get("skill_attributes") or {})
        records.append(call)

        duration_ms = _numeric(tool.get("duration_ms"))
        if duration_ms is None:
            duration_ns = max(0, int(tool["end_ns"]) - int(tool["start_ns"]))
            duration_ms = 0 if duration_ns == 0 else max(1, round(duration_ns / 1_000_000))
        result = _common_fields(
            turn, session_state, "tool.result", int(tool["end_ns"]), step_id, span_id
        )
        result.update({
            "gen_ai.provider.name": call["gen_ai.provider.name"],
            "gen_ai.tool.name": tool_name,
            "gen_ai.tool.call.id": call_id,
            "gen_ai.tool.call.exec.id": call_id,
            "gen_ai.tool.call.duration": duration_ms,
            "tool.result.status": tool.get("status") or "success",
        })
        if capture and "result" in tool:
            result["gen_ai.tool.call.result"] = tool["result"]
        result.update(tool.get("skill_attributes") or {})
        records.append(result)

    priority = {"llm.request": 0, "llm.response": 1, "tool.call": 2, "tool.result": 3}
    records.sort(key=lambda item: (int(item["time_unix_nano"]), priority[item["event.name"]]))
    previous = 0
    for record in records:
        timestamp = int(record["time_unix_nano"])
        if timestamp <= previous:
            timestamp = previous + 1
            record["time_unix_nano"] = str(timestamp)
            record["observed_time_unix_nano"] = str(timestamp)
        previous = timestamp
    return records


def _write_records(records: List[Dict[str, Any]]) -> None:
    if not records:
        return
    directory = _data_dir() / "logs" / "hermes-agent"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        os.chmod(directory, 0o700)
    except OSError:
        pass
    path = directory / ("hermes-agent-%s.jsonl" % _PROCESS_FILE_TOKEN)
    payload = "".join(
        json.dumps(record, ensure_ascii=True, separators=(",", ":"), default=str) + "\n"
        for record in records
    ).encode("utf-8")
    descriptor = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        offset = 0
        while offset < len(payload):
            written = os.write(descriptor, payload[offset:])
            if written <= 0:
                raise OSError("failed to append Hermes event records")
            offset += written
    finally:
        os.close(descriptor)


def _purge_old_logs() -> None:
    directory = _data_dir() / "logs" / "hermes-agent"
    try:
        cutoff = time.time() - LOG_RETENTION_SECONDS
        for candidate in directory.glob("hermes-agent-*.jsonl"):
            if candidate.is_file() and candidate.stat().st_mtime < cutoff:
                candidate.unlink(missing_ok=True)
    except Exception as error:
        _report_internal_error("log retention", error)


def _handle_on_session_start(now_ns: int, payload: Dict[str, Any]) -> None:
    session_id = payload.get("session_id")
    if not isinstance(session_id, str) or not session_id:
        return
    state = _session(session_id)
    state["model"] = payload.get("model") or state.get("model")
    state["platform"] = payload.get("platform") or state.get("platform")


def _handle_pre_llm_call(now_ns: int, payload: Dict[str, Any]) -> None:
    session_id = payload.get("session_id")
    if not isinstance(session_id, str) or not session_id:
        return
    state = _session(session_id)
    history = payload.get("conversation_history")
    history_length = len(history) if isinstance(history, list) else 1
    state["model"] = payload.get("model") or state.get("model")
    state["platform"] = payload.get("platform") or state.get("platform")
    state["current_turn"] = _new_turn(
        session_id,
        payload.get("user_message", ""),
        history_length,
        payload.get("sender_id", ""),
        payload.get("turn_id", ""),
    )


def _handle_pre_api_request(now_ns: int, payload: Dict[str, Any]) -> None:
    session_id = payload.get("session_id")
    if not isinstance(session_id, str) or not session_id:
        return
    state = _session(session_id)
    turn = state.get("current_turn")
    observer_turn_id = payload.get("turn_id")
    if turn is None:
        turn = _new_turn(session_id, observer_turn_id=observer_turn_id)
        state["current_turn"] = turn
    elif isinstance(observer_turn_id, str) and observer_turn_id:
        existing_turn_id = turn.get("observer_turn_id")
        if existing_turn_id and existing_turn_id != observer_turn_id:
            turn = _new_turn(session_id, observer_turn_id=observer_turn_id)
            state["current_turn"] = turn
        else:
            turn["observer_turn_id"] = observer_turn_id
    task_id = payload.get("task_id")
    if isinstance(task_id, str) and task_id:
        if not turn.get("observer_turn_id") and turn.get("task_id") not in (None, task_id):
            turn = _new_turn(session_id, observer_turn_id=observer_turn_id)
            state["current_turn"] = turn
        turn["task_id"] = task_id
    state["model"] = payload.get("model") or state.get("model")
    state["platform"] = payload.get("platform") or state.get("platform")
    turn["apis"].append({
        "task_id": task_id,
        "api_request_id": payload.get("api_request_id"),
        "api_call_count": payload.get("api_call_count"),
        "pre_ns": now_ns,
        "post_ns": None,
        "pre": {
            "provider": payload.get("provider"),
            "model": payload.get("model"),
            "tool_definitions": (
                _tool_definitions(payload.get("request"))
                if turn["capture_content"]
                else []
            ),
            "system_instructions": (
                _system_instructions(payload.get("request"))
                if turn["capture_content"]
                else []
            ),
        },
        "post": {},
    })


def _handle_post_api_request(now_ns: int, payload: Dict[str, Any]) -> None:
    session_id = payload.get("session_id")
    if not isinstance(session_id, str) or not session_id:
        return
    state = _session(session_id)
    turn = state.get("current_turn")
    if turn is None:
        return
    api = _match_api(
        turn,
        payload.get("task_id"),
        payload.get("api_call_count"),
        True,
        payload.get("api_request_id"),
    )
    if api is None:
        duration = payload.get("api_duration")
        duration_ns = int(float(duration) * 1_000_000_000) if isinstance(duration, (int, float)) else 1
        api = {
            "task_id": payload.get("task_id"),
            "api_request_id": payload.get("api_request_id"),
            "api_call_count": payload.get("api_call_count"),
            "pre_ns": max(1, now_ns - max(1, duration_ns)),
            "post_ns": None,
            "pre": {},
            "post": {},
        }
        turn["apis"].append(api)
    elif not api.get("api_request_id") and payload.get("api_request_id"):
        api["api_request_id"] = payload.get("api_request_id")
    api["post_ns"] = now_ns
    api["post"] = {
        "provider": payload.get("provider"),
        "model": payload.get("model"),
        "response_model": payload.get("response_model"),
        "finish_reason": payload.get("finish_reason"),
        "usage": _bounded_value(payload.get("usage")),
    }


def _handle_api_request_error(now_ns: int, payload: Dict[str, Any]) -> None:
    session_id = payload.get("session_id")
    if not isinstance(session_id, str) or not session_id:
        return
    state = _session(session_id)
    turn = state.get("current_turn")
    if turn is None:
        return
    api = _match_api(
        turn,
        payload.get("task_id"),
        payload.get("api_call_count"),
        True,
        payload.get("api_request_id"),
    )
    if api is None:
        duration = payload.get("api_duration")
        duration_ns = int(float(duration) * 1_000_000_000) if isinstance(duration, (int, float)) else 1
        api = {
            "task_id": payload.get("task_id"),
            "api_request_id": payload.get("api_request_id"),
            "api_call_count": payload.get("api_call_count"),
            "pre_ns": max(1, now_ns - max(1, duration_ns)),
            "post_ns": None,
            "pre": {},
            "post": {},
        }
        turn["apis"].append(api)
    elif not api.get("api_request_id") and payload.get("api_request_id"):
        api["api_request_id"] = payload.get("api_request_id")

    error = payload.get("error")
    if not isinstance(error, dict):
        error = {}
    error_type = error.get("type") or payload.get("reason") or "_OTHER"
    error_message = error.get("message") or payload.get("reason") or "provider request failed"
    api["post_ns"] = now_ns
    api["post"] = {
        "provider": payload.get("provider"),
        "model": payload.get("model"),
        "response_model": payload.get("response_model"),
        "finish_reason": "error",
        "error_type": _truncate(str(error_type)),
        "error_message": _truncate(str(error_message)),
        "status_code": payload.get("status_code"),
        "retryable": payload.get("retryable"),
        "retry_count": payload.get("retry_count"),
    }


def _handle_pre_tool_call(now_ns: int, payload: Dict[str, Any]) -> None:
    session_id = payload.get("session_id")
    call_id = payload.get("tool_call_id")
    if not isinstance(session_id, str) or not session_id or not isinstance(call_id, str) or not call_id:
        return
    state = _session(session_id)
    turn = state.get("current_turn")
    if turn is None:
        return
    task_id = payload.get("task_id")
    if turn.get("task_id") and task_id and turn["task_id"] != task_id:
        return
    observer_turn_id = payload.get("turn_id")
    if turn.get("observer_turn_id") and observer_turn_id and turn["observer_turn_id"] != observer_turn_id:
        return
    if call_id not in turn["tools"]:
        tool: Dict[str, Any] = {
            "tool_name": payload.get("tool_name"),
            "start_ns": now_ns,
            "end_ns": None,
            "skill_attributes": _skill_attributes(
                payload.get("tool_name"), payload.get("args")
            ),
        }
        if turn["capture_content"]:
            tool["args"] = _bounded_value(payload.get("args"))
        turn["tools"][call_id] = tool


def _handle_post_tool_call(now_ns: int, payload: Dict[str, Any]) -> None:
    session_id = payload.get("session_id")
    call_id = payload.get("tool_call_id")
    if not isinstance(session_id, str) or not session_id or not isinstance(call_id, str) or not call_id:
        return
    state = _session(session_id)
    turn = state.get("current_turn")
    if turn is None:
        return
    task_id = payload.get("task_id")
    if turn.get("task_id") and task_id and turn["task_id"] != task_id:
        return
    observer_turn_id = payload.get("turn_id")
    if turn.get("observer_turn_id") and observer_turn_id and turn["observer_turn_id"] != observer_turn_id:
        return
    tool = turn["tools"].get(call_id)
    if tool is None:
        tool = {
            "tool_name": payload.get("tool_name"),
            "start_ns": max(1, now_ns - 1),
            "end_ns": None,
        }
        turn["tools"][call_id] = tool
    tool["tool_name"] = payload.get("tool_name") or tool.get("tool_name")
    tool["end_ns"] = now_ns
    tool["status"] = _tool_status(payload.get("result"), payload.get("status"))
    duration_ms = _numeric(payload.get("duration_ms"))
    if duration_ms is not None:
        tool["duration_ms"] = duration_ms
    if turn["capture_content"]:
        if "args" not in tool:
            tool["args"] = _bounded_value(payload.get("args"))
        tool["result"] = _bounded_value(_decode_json(payload.get("result")))
    tool["skill_attributes"] = _skill_attributes(
        tool.get("tool_name"), payload.get("args"), payload.get("result")
    ) or tool.get("skill_attributes", {})


def _handle_post_llm_call(now_ns: int, payload: Dict[str, Any]) -> None:
    session_id = payload.get("session_id")
    if not isinstance(session_id, str) or not session_id:
        return
    state = _session(session_id)
    turn = state.get("current_turn")
    if turn is None:
        return
    state["model"] = payload.get("model") or state.get("model")
    state["platform"] = payload.get("platform") or state.get("platform")
    state["current_turn"] = None
    _write_records(_build_records(turn, state, payload))


def _handle_on_session_end(now_ns: int, payload: Dict[str, Any]) -> None:
    session_id = payload.get("session_id")
    if not isinstance(session_id, str) or not session_id:
        return
    state = _SESSIONS.get(session_id)
    if state is None:
        return
    turn = state.get("current_turn")
    if turn is None or not any(api.get("post_ns") is not None for api in turn["apis"]):
        return
    state["current_turn"] = None
    _write_records(_build_records(turn, state, payload))


def _handle_on_session_finalize(now_ns: int, payload: Dict[str, Any]) -> None:
    session_id = payload.get("session_id")
    if isinstance(session_id, str) and session_id:
        _SESSIONS.pop(session_id, None)


_HANDLERS: Dict[str, Callable[[int, Dict[str, Any]], None]] = {
    "on_session_start": _handle_on_session_start,
    "pre_llm_call": _handle_pre_llm_call,
    "pre_api_request": _handle_pre_api_request,
    "post_api_request": _handle_post_api_request,
    "api_request_error": _handle_api_request_error,
    "pre_tool_call": _handle_pre_tool_call,
    "post_tool_call": _handle_post_tool_call,
    "post_llm_call": _handle_post_llm_call,
    "on_session_end": _handle_on_session_end,
    "on_session_finalize": _handle_on_session_finalize,
}


def _safe_callback(hook_name: str) -> Callable[..., None]:
    def callback(**kwargs: Any) -> None:
        try:
            with _STATE_LOCK:
                _HANDLERS[hook_name](time.time_ns(), kwargs)
        except Exception as error:
            # Observability must never affect the Hermes conversation.
            _report_internal_error(hook_name, error)
            return None

    return callback


def register(ctx: Any) -> None:
    """Register synchronous Hermes lifecycle callbacks."""
    _purge_old_logs()
    for hook_name in HOOKS:
        try:
            ctx.register_hook(hook_name, _safe_callback(hook_name))
        except Exception:
            continue
