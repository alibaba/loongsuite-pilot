"""Native Hermes Agent event collector for LoongSuite Pilot."""

from __future__ import annotations

import atexit
import contextvars
import functools
import hashlib
import importlib
import inspect
import json
import os
import re
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
MAX_ACTIVE_TURNS = 100
MAX_TURN_MESSAGES = 64
MAX_PARTS = 64
MAX_COLLECTION_ITEMS = 128
MAX_CONTENT_CHARS = 32 * 1024
MAX_PENDING_INPUT_RECORDS = 128
MAX_PENDING_INPUT_BYTES = 2 * 1024 * 1024
MAX_VALUE_DEPTH = 8
MAX_RESOURCE_FIELD_VALUE_LENGTH = 512
LEGACY_SYSTEM_INSTRUCTIONS_TTL_NS = 5_000_000_000
LOG_RETENTION_SECONDS = 7 * 24 * 60 * 60
MANAGED_MARKER_FILE = ".loongsuite-pilot-managed.json"
INVOCATION_USER_ID_FIELD = "agent.pilot.invocation.user.id"

_PROCESS_FILE_TOKEN = "%s-%s-%s" % (
    os.getpid(),
    time.time_ns(),
    secrets.token_hex(4),
)
_STATE_LOCK = threading.RLock()
# Never hold this lock during file I/O or native callbacks. Closing an API and
# observing its first delta must be atomic without waiting for another turn's
# synchronous JSONL append. Lock order is STATE -> TTFT, never the reverse.
_TTFT_LOCK = threading.Lock()
_SESSIONS: Dict[str, Dict[str, Any]] = {}
# Detached retry snapshots retain no other active turns/session state.
_EVICTED_TURNS: Dict[str, Any] = {}
_TTFT_API: contextvars.ContextVar = contextvars.ContextVar("pilot_hermes_ttft", default=None)
_ACTIVE_DELEGATION = contextvars.ContextVar("pilot_hermes_delegation", default=None)
_LEGACY_SYSTEM_INSTRUCTIONS = contextvars.ContextVar("pilot_hermes_legacy_system", default=None)


def _stream_api_for_agent(agent: Any) -> Optional[Dict[str, Any]]:
    # New Hermes executes each hook in an isolated copy_context worker: setting
    # a ContextVar there cannot update the caller. Match the native agent's
    # explicit turn/task identity, never the latest request in a session.
    session_id = getattr(agent, "session_id", None)
    turn_id = getattr(agent, "_current_turn_id", None)
    task_id = getattr(agent, "_current_task_id", None)
    if not session_id or not (turn_id or task_id):
        return None
    with _STATE_LOCK:
        candidates = []
        for turn in _SESSIONS.get(session_id, {}).get("turns", {}).values():
            if turn_id and turn.get("observer_turn_id") != turn_id:
                continue
            if task_id and turn.get("task_id") != task_id:
                continue
            candidates.extend(api for api in turn["apis"] if api.get("post_ns") is None)
        return candidates[0] if len(candidates) == 1 else None


def _install_first_delta_observer() -> None:
    """Observe Hermes' native first delta without changing its stream or callbacks.

    Install lazily: plugin discovery can run before AIAgent finishes importing.
    Hermes starts a plain Thread for streaming, so capture the request in the
    caller context and carry it into that thread via the callback closure.
    """
    try:
        module = sys.modules.get("run_agent") or sys.modules.get("__main__")
        agent_class = getattr(module, "AIAgent", None)
        owner, attribute = agent_class, "_interruptible_streaming_api_call"
        original = getattr(agent_class, "_interruptible_streaming_api_call", None)
        if not callable(original):
            return
        # New Hermes facades lazily forward (*args, **kwargs). Wrap the known
        # native helper instead; guessing a generic wrapper's argument layout
        # would change callbacks on unrelated/older hosts.
        if (getattr(original, "__module__", "") == "agent.lazy_forward"
                and "on_first_delta" not in inspect.signature(original).parameters):
            owner = importlib.import_module("agent.chat_completion_helpers")
            attribute = "interruptible_streaming_api_call"
            original = getattr(owner, attribute, None)
            if not callable(original):
                return
        if hasattr(original, "_pilot_ttft_context"):
            # Plugin rediscovery must use the new module's request context.
            original._pilot_ttft_context = _TTFT_API
            original._pilot_ttft_resolve = _stream_api_for_agent
            return
        signature = inspect.signature(original)
        parameter = signature.parameters.get("on_first_delta")
        if parameter is None or parameter.kind not in (
            inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.KEYWORD_ONLY
        ):
            return

        @functools.wraps(original)
        def observed(agent: Any, *args: Any, **kwargs: Any) -> Any:
            api = observed._pilot_ttft_context.get()
            observed._pilot_ttft_context.set(None)
            if api is None:
                api = observed._pilot_ttft_resolve(agent)
            # Other wire protocols do not share the same first-output semantics.
            if (
                api is None or api.get("post_ns") is not None
                or getattr(agent, "api_mode", None) != "chat_completions"
                or getattr(agent, "session_id", None) != api.get("session_id")
            ):
                return original(agent, *args, **kwargs)
            try:
                bound = signature.bind(agent, *args, **kwargs)
            except Exception:
                return original(agent, *args, **kwargs)
            callback = bound.arguments.get("on_first_delta")

            def first_delta(*callback_args: Any, **callback_kwargs: Any) -> Any:
                try:
                    first_ns = time.perf_counter_ns()
                    with _TTFT_LOCK:
                        if (
                            not getattr(agent, "_disable_streaming", False)
                            and api.get("post_ns") is None
                            and api.get("first_token_ns") is None
                        ):
                            api["first_token_ns"] = first_ns
                except Exception:
                    pass
                if callback is not None:
                    return callback(*callback_args, **callback_kwargs)
                return None

            bound.arguments["on_first_delta"] = first_delta
            return original(*bound.args, **bound.kwargs)

        observed._pilot_ttft_context = _TTFT_API
        observed._pilot_ttft_resolve = _stream_api_for_agent
        setattr(owner, attribute, observed)
    except Exception:
        # Older Hermes versions retain event collection without TTFT.
        pass


def _parent_context_path(session_id: str) -> Path:
    return _data_dir() / "subagent-contexts" / "hermes" / (hashlib.sha256(session_id.encode()).hexdigest() + ".json")


def _read_parent_context(session_id: str) -> Dict[str, Any]:
    value = _read_json_object(_parent_context_path(session_id))
    if (value.get("session_id") == session_id
            and isinstance(value.get("expires_at"), (int, float)) and value["expires_at"] > time.time()
            and isinstance(value.get("trace_id"), str) and len(value["trace_id"]) == 32
            and set(value["trace_id"]) <= set("0123456789abcdef") and set(value["trace_id"]) != {"0"}
            and isinstance(value.get("parent_span_id"), str) and len(value["parent_span_id"]) == 16
            and set(value["parent_span_id"]) <= set("0123456789abcdef") and set(value["parent_span_id"]) != {"0"}
            and isinstance(value.get("user_id"), str) and bool(value["user_id"])
            and all(isinstance(value.get(key), str) and value[key] for key in ("parent_session_id", "parent_turn_id", "tool_call_id"))):
        return value
    return {}


def _install_delegate_context() -> None:
    """Hermes hooks omit parent/tool identity. Adapt the native child factory,
    before thread submission, instead of guessing from goals or active sessions.
    Only this optional factory is wrapped; arguments, results and exceptions
    retain their original behavior. Older hosts without it keep normal hooks.
    """
    try:
        module = importlib.import_module("tools.delegate_tool")
        original = module._build_child_agent
        if getattr(original, "_pilot_subagent_context", False):
            return
        signature = inspect.signature(original)
        if "parent_agent" not in signature.parameters:
            return

        @functools.wraps(original)
        def build_child(*args: Any, **kwargs: Any) -> Any:
            relation = None
            try:
                parent = signature.bind(*args, **kwargs).arguments.get("parent_agent")
                active = _ACTIVE_DELEGATION.get()
                with _STATE_LOCK:
                    if active and active[0] == getattr(parent, "session_id", None):
                        turn = next((candidate for candidate in
                                     _SESSIONS.get(active[0], {}).get("turns", {}).values()
                                     if _turn_id(candidate) == active[1]), None)
                        tool = turn.get("tools", {}).get(active[2]) if turn else None
                        if turn and _turn_id(turn) == active[1] and tool and tool.get("end_ns") is None:
                            relation = {
                                "trace_id": turn["trace_id"], "parent_span_id": tool["span_id"],
                                "parent_session_id": turn["session_id"], "parent_turn_id": _turn_id(turn),
                                "tool_call_id": active[2], "user_id": turn["user_id"],
                            }
            except Exception as error:
                _report_internal_error("delegate_context", error)
            child = original(*args, **kwargs)
            try:
                sid = getattr(child, "session_id", None)
                if relation and isinstance(sid, str) and sid:
                    target = _parent_context_path(sid)
                    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    # Clean expired identity-only records, never transcripts.
                    for old in target.parent.glob("*.json"):
                        if time.time() - old.stat().st_mtime > LOG_RETENTION_SECONDS:
                            old.unlink(missing_ok=True)
                    value = dict(relation, session_id=sid, expires_at=time.time() + LOG_RETENTION_SECONDS)
                    temp = target.with_suffix("." + uuid.uuid4().hex + ".tmp")
                    try:
                        fd = os.open(str(temp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                        with os.fdopen(fd, "w") as stream:
                            json.dump(value, stream)
                        os.replace(temp, target)
                    finally:
                        temp.unlink(missing_ok=True)
            except Exception as error:
                _report_internal_error("delegate_context", error)
            return child

        build_child._pilot_subagent_context = True
        module._build_child_agent = build_child
    except (ImportError, AttributeError):
        pass
    except Exception as error:
        _report_internal_error("delegate_context", error)



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
        declarations: Any = None
        if isinstance(value, dict):
            declarations = value.get("functionDeclarations")
            if not isinstance(declarations, list):
                declarations = value.get("function_declarations")
        candidates = declarations if isinstance(declarations, list) else [value]
        for candidate in candidates:
            definition = _tool_definition(candidate)
            if definition is not None:
                output.append(definition)
                if len(output) >= MAX_COLLECTION_ITEMS:
                    return output
    return output


def _text_parts(value: Any, ascii_only: bool = False) -> List[Dict[str, str]]:
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
        if isinstance(text, str) and ascii_only:
            # Match 4.16's last-resort payload rewrite before bounding the text.
            text = text.encode("ascii", errors="ignore").decode("ascii")
        if isinstance(text, str) and text.strip():
            parts.append({"type": "text", "content": _truncate(text)})
    return parts


def _system_instructions(request: Any, ascii_only: bool = False) -> List[Dict[str, str]]:
    """Extract the system prompt from a provider request body.

    Hermes never replays system messages through conversation_history. Shapes
    differ per provider: Anthropic/Bedrock keep the prompt in a
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
            parts = _text_parts(body.get(key), ascii_only)
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
        parts.extend(_text_parts(message.get("content"), ascii_only))
        if len(parts) >= MAX_PARTS:
            break
    return parts[:MAX_PARTS]


def _clear_legacy_system_instructions() -> None:
    try:
        _LEGACY_SYSTEM_INSTRUCTIONS.set(None)
    except Exception:
        pass


def _install_legacy_system_observer() -> None:
    """Read 4.16 instructions after native provider request conversion.

    That release's synchronous pre_api_request hook omits request.body. Keep
    only bounded text parts in the caller's context, never the conversation,
    credentials or tool definitions. Other releases keep their native hooks.
    """
    try:
        import hermes_cli
        if (getattr(hermes_cli, "__version__", None),
                getattr(hermes_cli, "__release_date__", None)) != ("0.10.0", "2026.4.16"):
            return
        module = sys.modules.get("run_agent") or sys.modules.get("__main__")
        owner = getattr(module, "AIAgent", None)

        def observe(original: Callable, modes: tuple) -> Callable:
            @functools.wraps(original)
            def observed(agent: Any, *args: Any, **kwargs: Any) -> Any:
                try:
                    observed._pilot_legacy_system_context.set(None)
                except Exception:
                    pass
                # Native results and exceptions retain their original behavior.
                body = original(agent, *args, **kwargs)
                try:
                    session_id = getattr(agent, "session_id", None)
                    mode = getattr(agent, "api_mode", None)
                    if isinstance(session_id, str) and session_id and mode in modes:
                        parts = observed._pilot_legacy_system_extract(
                            {"body": body},
                            ascii_only=bool(getattr(agent, "_force_ascii_payload", False)))
                        if parts:
                            observed._pilot_legacy_system_context.set(
                                (session_id, mode, time.monotonic_ns(), parts))
                except Exception:
                    pass
                return body

            observed._pilot_legacy_system_context = _LEGACY_SYSTEM_INSTRUCTIONS
            observed._pilot_legacy_system_extract = _system_instructions
            return observed

        # Responses preflight can replace/normalize instructions after building.
        # The other three modes finish provider conversion in the builder.
        for name, names, modes in (
            ("_build_api_kwargs", ["self", "api_messages"],
             ("chat_completions", "anthropic_messages", "bedrock_converse")),
            ("_preflight_codex_api_kwargs", ["self", "api_kwargs", "allow_stream"],
             ("codex_responses",)),
        ):
            original = getattr(owner, name, None)
            if not callable(original):
                continue
            if hasattr(original, "_pilot_legacy_system_context"):
                # Rediscovery hands existing wrappers the new module's state.
                original._pilot_legacy_system_context = _LEGACY_SYSTEM_INSTRUCTIONS
                original._pilot_legacy_system_extract = _system_instructions
                continue
            parameters = inspect.signature(original).parameters
            values = list(parameters.values())
            if (list(parameters) != names
                    or any(p.kind != inspect.Parameter.POSITIONAL_OR_KEYWORD
                           for p in values[:2])
                    or (len(values) == 3 and (
                        values[2].kind != inspect.Parameter.KEYWORD_ONLY
                        or values[2].default is not False))):
                continue
            setattr(owner, name, observe(original, modes))
    except Exception:
        pass


def _request_system_instructions(payload: Dict[str, Any]) -> List[Dict[str, str]]:
    pending = None
    try:
        pending = _LEGACY_SYSTEM_INSTRUCTIONS.get()
    except Exception:
        pass
    finally:
        _clear_legacy_system_instructions()
    # Even a blank/malformed native request is authoritative; don't replace it.
    if "request" in payload:
        request = payload.get("request")
        parts = _system_instructions(request)
        native_parts = _text_parts(payload.get("system_prompt"))
        if not native_parts or len(native_parts) != len(parts):
            native_parts = _system_instructions(
                {"body": {"messages": payload.get("request_messages")}}) or native_parts
        # Modern Hermes caps each request-body string at 8,000 characters, but
        # exposes uncapped prompt/message fields in the same Hook. Repair only
        # explicit truncation with matching text; keep ordinary request bodies first.
        if isinstance(request, dict) and request.get("_truncated") is True and "body" not in request:
            return native_parts
        if not parts or len(native_parts) != len(parts):
            return parts
        for part, native_part in zip(parts, native_parts):
            if part == native_part:
                continue
            match = re.fullmatch(r"(.*)\.\.\.\[truncated (\d+) chars\]", part["content"], re.DOTALL)
            content = native_part["content"]
            if (not match or not content.startswith(match.group(1))
                    or (len(content) <= MAX_CONTENT_CHARS
                        and len(content) != len(match.group(1)) + int(match.group(2)))):
                return parts
        return native_parts
    try:
        if (pending and pending[0] == payload.get("session_id")
                and pending[1] == payload.get("api_mode")
                and 0 <= time.monotonic_ns() - pending[2] <= LEGACY_SYSTEM_INSTRUCTIONS_TTL_NS):
            return pending[3]
    except Exception:
        pass
    return []


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
            "turns": {},
            "turn_count": 0,
            "finalize_requested": False,
        }
        _SESSIONS[session_id] = state
        while len(_SESSIONS) > MAX_SESSIONS:
            oldest = next(
                (
                    candidate
                    for candidate, candidate_state in _SESSIONS.items()
                    if candidate != session_id and not candidate_state["turns"]
                ),
                next(iter(_SESSIONS)),
            )
            evicted = _SESSIONS.pop(oldest, None)
            if evicted:
                for turn in list(evicted["turns"].values()):
                    try:
                        _flush_turn(evicted, turn, {})
                    except Exception as error:
                        _defer_evicted_turn(evicted, turn)
                        _report_internal_error("session eviction flush", error)
    else:
        _SESSIONS.pop(session_id, None)
        _SESSIONS[session_id] = state
    return state


def _new_turn(
    session_id: str,
    user_message: Any = "",
    sender_id: Any = "",
    observer_turn_id: Any = "",
) -> Dict[str, Any]:
    config = _config()
    normalized_sender_id = _normalized_identity(sender_id)
    user_identity = _resolve_user_identity(normalized_sender_id, config)
    parent = _read_parent_context(session_id)
    if parent and user_identity["source"] in ("config", "hostname"):
        user_identity = {"user_id": parent["user_id"], "source": "parent"}
    elif not normalized_sender_id and user_identity["source"] in ("config", "hostname"):
        previous = _SESSIONS.get(session_id, {}).get("sender_identity")
        if previous:
            user_identity = dict(previous)
    if normalized_sender_id and user_identity["source"] == "sender":
        _session(session_id)["sender_identity"] = dict(user_identity)
    return {
        "session_id": session_id,
        "task_id": None,
        "thread_id": threading.get_ident(),
        "observer_turn_id": (
            observer_turn_id if isinstance(observer_turn_id, str) and observer_turn_id else None
        ),
        "fallback_turn_id": "%s:%s" % (session_id, uuid.uuid4()),
        "trace_id": parent.get("trace_id") or _new_trace_id(),
        "parent_context": parent,
        "user_id": user_identity["user_id"],
        "user_id_source": user_identity["source"],
        "sender_id": normalized_sender_id,
        "user_message": user_message if isinstance(user_message, str) else str(user_message or ""),
        # None means the initial history boundary was not observed. Do not
        # confuse an empty snapshot with a known first-message boundary.
        "history_start": None,
        "apis": [],
        "tools": {},
    }


def _find_turn(state: Dict[str, Any], payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    turns = list(state["turns"].values())
    observer_id = payload.get("turn_id")
    task_id = payload.get("task_id")
    if isinstance(observer_id, str) and observer_id:
        found = next((turn for turn in turns if turn["observer_turn_id"] == observer_id), None)
        if found is not None:
            return found
        turns = [turn for turn in turns if not turn["observer_turn_id"]]
    if isinstance(task_id, str) and task_id:
        matching = [turn for turn in turns if turn["task_id"] == task_id]
        if len(matching) == 1:
            return matching[0]
        if matching:
            turns = matching
        else:
            turns = [turn for turn in turns if not turn["task_id"]]
    # Older hooks omit IDs at pre_llm_call/finish. Only adopt an unambiguous
    # turn on the same thread; never pick another thread's current invocation.
    turns = [turn for turn in turns if turn["thread_id"] == threading.get_ident()]
    return turns[0] if len(turns) == 1 else None


def _remember_turn(state: Dict[str, Any], turn: Dict[str, Any], payload: Dict[str, Any]) -> None:
    task_id = payload.get("task_id")
    if isinstance(task_id, str) and task_id:
        turn["task_id"] = task_id
    turn["model"] = payload.get("model") or state.get("model")
    turn["platform"] = payload.get("platform") or state.get("platform")
    if turn["fallback_turn_id"] not in state["turns"]:
        state["turn_count"] = min(2, state["turn_count"] + 1)
    state["turns"][turn["fallback_turn_id"]] = turn
    while len(state["turns"]) > MAX_ACTIVE_TURNS:
        oldest = next(candidate for candidate in state["turns"].values() if candidate is not turn)
        try:
            _flush_turn(state, oldest, {})
        except Exception as error:
            # A failing lifecycle flush remains retryable in the active map;
            # capacity eviction must still make room for this hook's turn.
            _defer_evicted_turn(state, oldest)
            _report_internal_error("turn eviction flush", error)


def _defer_evicted_turn(state: Dict[str, Any], turn: Dict[str, Any]) -> None:
    key = turn["fallback_turn_id"]
    state["turns"].pop(key, None)
    _EVICTED_TURNS[key] = ({
        "model": state.get("model"), "platform": state.get("platform"),
        "turns": {key: turn}, "finalize_requested": False,
    }, turn)
    while len(_EVICTED_TURNS) > MAX_ACTIVE_TURNS:
        _EVICTED_TURNS.pop(next(iter(_EVICTED_TURNS)))
        _report_internal_error("eviction retry capacity", RuntimeError("dropping oldest evicted turn"))


def _flush_turn(state: Dict[str, Any], turn: Dict[str, Any], payload: Dict[str, Any]) -> None:
    _capture_turn_input(turn, _current_turn_messages(turn, payload))
    if not turn.get("input_content_hash"):
        turn["input_resolution_closed"] = True
    # Also drain requests without a response: input must not be required for
    # collection at completion, eviction or process exit.
    _write_new_records(turn, _build_records(turn, state, payload, final=True))
    if turn["apis"]:
        api = turn["apis"][-1]
        step_id, _ = _api_ids(turn, api)
        terminal = _common_fields(turn, state, "other", time.time_ns(), step_id, api["span_id"])
        terminal.update({
            "gen_ai.provider.name": _provider_name((api.get("pre") or {}).get("provider")),
            "agent.hermes.hook": "turn_end",
            "gen_ai.turn.end": True,
        })
        _write_new_records(turn, [terminal])
    # A failed append must leave the turn available for lifecycle/exit retry.
    state["turns"].pop(turn["fallback_turn_id"], None)
    if state["finalize_requested"] and not state["turns"]:
        session_id = turn["session_id"]
        if _SESSIONS.get(session_id) is state:
            _SESSIONS.pop(session_id, None)


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


def _tool_calls(message: Dict[str, Any]) -> List[Dict[str, Any]]:
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
        if "arguments" in function:
            part["arguments"] = _bounded_value(_decode_json(function.get("arguments")))
        output.append(part)
    return output


def _message(message: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(message, dict):
        return None
    role = str(message.get("role") or "unknown")
    parts: List[Dict[str, Any]] = []
    content = message.get("content")

    if role == "tool":
        call_id = message.get("tool_call_id") or message.get("call_id")
        response = _bounded_value(_decode_json(content))
        parts.append({
            "type": "tool_call_response",
            "id": str(call_id) if call_id else None,
            "response": response,
        })
    else:
        if isinstance(content, str):
            if content or not message.get("tool_calls"):
                parts.append({"type": "text", "content": _truncate(content)})
        elif isinstance(content, list):
            for item in content[:MAX_PARTS]:
                if isinstance(item, dict) and item.get("type") in ("text", "input_text", "output_text"):
                    text = item.get("text", item.get("content", ""))
                    parts.append({
                        "type": "text",
                        "content": _truncate(str(text or "")),
                    })
        elif content is not None:
            parts.append({
                "type": "text",
                "content": _truncate(str(content)),
            })
        parts.extend(_tool_calls(message))

    if not parts:
        parts.append({"type": "text", "content": ""})
    output: Dict[str, Any] = {"role": role, "parts": parts[:MAX_PARTS]}
    finish_reason = message.get("finish_reason")
    if isinstance(finish_reason, str) and finish_reason:
        output["finish_reason"] = finish_reason
    return output


def _messages(messages: List[Any]) -> List[Dict[str, Any]]:
    output: List[Dict[str, Any]] = []
    for item in messages[-MAX_TURN_MESSAGES:]:
        converted = _message(item)
        if converted is not None:
            output.append(converted)
    return output


def _current_turn_messages(turn: Dict[str, Any], payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    history = payload.get("conversation_history")
    if not isinstance(history, list):
        history = []
    start = turn.get("history_start")
    if start is None and history:
        # The first request can carry the whole resumed conversation. Establish
        # its current user boundary once, then retain it through tool retries.
        start = next((i for i in range(len(history) - 1, -1, -1)
                      if isinstance(history[i], dict) and history[i].get("role") == "user"), None)
        if start is not None:
            turn["history_start"] = start
    current = [item for item in history[start:] if isinstance(item, dict)] if start is not None else []
    if not current:
        text = turn.get("user_message", "")
        if not text and isinstance(payload.get("user_message"), str):
            text = payload["user_message"]
        current = [{"role": "user", "content": text}]
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
    platform = turn.get("platform") or session_state.get("platform") or "cli"
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
        "agent.hermes.collection": "realtime-v1",
    }
    if turn.get("user_id_source") in ("invocation", "environment", "sender", "parent"):
        fields[INVOCATION_USER_ID_FIELD] = turn["user_id"]
    if turn.get("sender_id"):
        fields["agent.hermes.sender.id"] = turn["sender_id"]
    parent = turn.get("parent_context")
    if parent:
        fields.update({
            "parent_span_id": parent["parent_span_id"],
            "gen_ai.agent.scope": "subagent",
            "gen_ai.agent.parent.id": parent["parent_session_id"],
            "gen_ai.subagent.parent_tool_call.id": parent["tool_call_id"],
            "agent.pilot.parent.turn.id": parent["parent_turn_id"],
        })
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


def _api_ids(turn: Dict[str, Any], api: Dict[str, Any]) -> Any:
    if not api.get("span_id"):
        api["span_id"] = _new_span_id()
    if not api.get("step_id"):
        index = next(i for i, item in enumerate(turn["apis"]) if item is api)
        api["step_id"] = "%s:s%s" % (_turn_id(turn), index + 1)
    return api["step_id"], "%s:r" % api["step_id"]


def _record_key(record: Dict[str, Any]) -> Any:
    return record["event.name"], record.get("gen_ai.step.id"), record.get("gen_ai.tool.call.id")


def _append_record(turn: Dict[str, Any], record: Dict[str, Any]) -> None:
    emitted = turn.setdefault("emitted", set())
    event_ids = turn.setdefault("event_ids", {})
    key = _record_key(record)
    if key in emitted:
        return
    record["event.id"] = event_ids.setdefault(key, record["event.id"])
    _write_records([record])
    emitted.add(key)


def _write_new_records(turn: Dict[str, Any], records: List[Dict[str, Any]]) -> None:
    emitted = turn.setdefault("emitted", set())
    pending = turn.setdefault("pending_records", {})
    # Retry committed-to-release records before accepting more snapshots. A
    # persistently failing writer must not grow staging on every later hook.
    _drain_pending_records(turn)
    for record in records:
        key = _record_key(record)
        if key in emitted or key in pending:
            continue
        size = len(json.dumps(record, ensure_ascii=True, default=str).encode("utf-8"))
        pending[key] = (record, size)
        turn["pending_bytes"] = turn.get("pending_bytes", 0) + size
        if not turn.get("input_content_hash") and not turn.get("input_resolution_closed"):
            if len(pending) > MAX_PENDING_INPUT_RECORDS or turn["pending_bytes"] > MAX_PENDING_INPUT_BYTES:
                # Once local export starts, late input cannot change this trace.
                turn["input_resolution_closed"] = True
        _drain_pending_records(turn)


def _drain_pending_records(turn: Dict[str, Any]) -> None:
    pending = turn.get("pending_records", {})
    if not turn.get("input_content_hash") and not turn.get("input_resolution_closed"):
        return
    if pending and turn.get("input_content_hash") and not turn.get("input_resolution_closed"):
        request = next((r for r, _ in pending.values() if r["event.name"] == "llm.request"), None)
        if request is not None:
            _write_turn_input(turn, request)
    for key in list(pending):
        record, size = pending[key]
        _append_record(turn, record)
        pending.pop(key)
        turn["pending_bytes"] -= size


def _capture_turn_input(turn: Dict[str, Any], messages: List[Dict[str, Any]]) -> None:
    # Capture only this turn's first user message, before display truncation.
    # Keep a bounded display value and the existing correlation protocol hash;
    # gen_ai.input.messages_hash hashes a different (structured) representation.
    if turn.get("input_content_hash") or turn.get("input_resolution_closed"):
        return
    message = next((item for item in messages if item.get("role") == "user"), {})
    content = message.get("content")
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        text = "".join(str(item.get("text", item.get("content", "")) or "")
                       for item in content if isinstance(item, dict)
                       and item.get("type") in ("text", "input_text", "output_text"))
    else:
        text = ""
    if text:
        turn["input_text"] = _truncate(text)
        turn["input_content_hash"] = hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
        if not turn.get("user_message"):
            turn["user_message"] = turn["input_text"]
        # Later hooks may omit history; retain the newly observed input for them.
        turn["initial_messages"] = _bounded_value([message])


def _write_turn_input(turn: Dict[str, Any], request: Dict[str, Any]) -> None:
    # Wait until the first API request has bound the native turn/task id, then
    # append input before any LLM record can be collected on a different trace.
    # The input has no step id: it is once per turn and must not collide with
    # the step-scoped turn_end marker or repeat on retries/lifecycle flushes.
    if ("other", None, None) in turn.get("emitted", set()) or not turn.get("input_content_hash"):
        return
    if not turn.get("input_span_id"):
        turn["input_span_id"] = _new_span_id()
    first_api_ns = int(turn["apis"][0]["pre_ns"])
    record = _common_fields(
        turn, {}, "other", first_api_ns, "", turn["input_span_id"]
    )
    record.pop("gen_ai.step.id", None)
    record.update({
        "agent.hermes.hook": "turn_start",
        "gen_ai.provider.name": request.get("gen_ai.provider.name", "unknown"),
        "agent.pilot.correlation.content_hash": turn["input_content_hash"],
        "gen_ai.input.messages_delta": [{"role": "user", "parts": [
            {"type": "text", "content": turn["input_text"]}
        ]}],
    })
    # Reuse stable event ids and append acknowledgement. If this write fails,
    # leave the input retryable and do not let the request overtake it.
    _append_record(turn, record)


def _request_messages(turn: Dict[str, Any], api: Dict[str, Any], payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    if isinstance(payload.get("conversation_history"), list):
        return _current_turn_messages(turn, payload)
    # Older hooks omit request history. Retain only observed boundaries; never
    # invent response text. Tool hooks still supply their actual call/result.
    messages = list(turn.get("initial_messages") or [{"role": "user", "content": turn["user_message"]}])
    for previous in turn["apis"]:
        if previous is api:
            break
        assistant = (previous.get("post") or {}).get("assistant_message")
        tools = [(cid, tool) for cid, tool in turn["tools"].items()
                 if tool.get("api") is previous]
        if assistant:
            messages.append(assistant)
        elif tools:
            messages.append({"role": "assistant", "tool_calls": [
                {"id": cid, "type": "function", "function": {
                    "name": tool.get("tool_name"), "arguments": tool.get("args", {})}}
                for cid, tool in tools]})
        for cid, tool in tools:
            if tool.get("end_ns") is not None:
                messages.append({"role": "tool", "tool_call_id": cid,
                                 "content": tool.get("result", "")})
    return messages[-MAX_TURN_MESSAGES:]


def _emit_request(turn: Dict[str, Any], state: Dict[str, Any], api: Dict[str, Any], payload: Dict[str, Any]) -> None:
    step_id, response_id = _api_ids(turn, api)
    messages = _request_messages(turn, api, payload)
    _capture_turn_input(turn, messages)
    index = next(i for i, item in enumerate(turn["apis"]) if item is api)
    delta_start = 0
    if index:
        positions = [i for i, item in enumerate(messages) if item.get("role") == "assistant"]
        if positions:
            delta_start = positions[-1]
    pre = api.get("pre") or {}
    inputs = _messages(messages)
    record = _common_fields(turn, state, "llm.request", api["pre_ns"], step_id, api["span_id"])
    record.update({
        "gen_ai.provider.name": _provider_name(pre.get("provider")),
        "gen_ai.request.id": api.get("api_request_id") or "%s:a%s" % (_turn_id(turn), index + 1),
        "gen_ai.response.id": response_id,
        "gen_ai.request.model": pre.get("model") or turn.get("model") or "unknown",
        "gen_ai.input.messages": inputs,
        "gen_ai.input.messages_delta": _messages(messages[delta_start:]),
        "gen_ai.input.messages_hash": hashlib.sha256(
            json.dumps(inputs, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest(),
        "agent.hermes.hook": "pre_api_request",
    })
    for key in ("tool_definitions", "system_instructions"):
        if pre.get(key):
            record["gen_ai.tool.definitions" if key == "tool_definitions" else "gen_ai.system_instructions"] = pre[key]
    _write_new_records(turn, [record])


def _build_records(
    turn: Dict[str, Any],
    session_state: Dict[str, Any],
    payload: Dict[str, Any],
    final: bool = False,
) -> List[Dict[str, Any]]:
    apis = [api for api in turn["apis"] if api.get("post_ns") is not None]
    if not apis:
        return []
    current_messages = _current_turn_messages(turn, payload)
    _capture_turn_input(turn, current_messages)
    assistant_positions = [
        index for index, message in enumerate(current_messages)
        if message.get("role") == "assistant"
    ]
    turn_id = _turn_id(turn)
    records: List[Dict[str, Any]] = []
    tool_step: Dict[str, int] = {}

    previous_assistant_position: Optional[int] = None
    assistant_cursor = 0
    for index, api in enumerate(apis):
        step_number = index + 1
        step_id, response_id = _api_ids(turn, api)
        span_id = api["span_id"]
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

        # Current Hermes exposes the normalized response at post_api_request.
        # Legacy hooks recover missing content at the final history boundary.
        known_assistant = post.get("assistant_message")
        if isinstance(known_assistant, dict):
            assistant_message = known_assistant

        for call in _tool_calls(assistant_message):
            call_id = call.get("id")
            if call_id:
                tool_step[str(call_id)] = index

        pre = api.get("pre") or {}
        tool_definitions = pre.get("tool_definitions")
        system_instructions = pre.get("system_instructions")
        # System instructions are provider configuration, not turn messages.
        # Keep them in their dedicated field so they do not alter the existing
        # input, delta, or input-hash semantics.
        input_messages = _messages(input_source)
        input_delta = _messages(delta_source)
        output_message = _message(assistant_message)
        provider = _provider_name(post.get("provider") or pre.get("provider"))
        request_model = str(pre.get("model") or post.get("model") or turn.get("model") or session_state.get("model") or "unknown")
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
            response["error.message"] = str(post.get("error_message") or "provider request failed")
            status_code = _numeric(post.get("status_code"))
            if status_code is not None:
                response["http.status_code"] = status_code
        response.update(_usage_fields(post))
        first_ns = api.get("first_token_ns")
        started_ns = api.get("started_perf_ns")
        if isinstance(first_ns, int) and isinstance(started_ns, int) and first_ns > started_ns:
            response["gen_ai.response.time_to_first_token"] = first_ns - started_ns
        if final or is_error or known_assistant is not None or assistant_position is not None:
            records.append(response)

    for call_id, tool in turn["tools"].items():
        api_index = tool_step.get(call_id)
        if api_index is None:
            api_index = 0
            for index, api in enumerate(apis):
                if int(api["post_ns"]) <= int(tool["start_ns"]):
                    api_index = index
        api_index = min(api_index, len(apis) - 1)
        owner_api = tool.get("api") or apis[api_index]
        tool["api"] = owner_api
        step_id, _ = _api_ids(turn, owner_api)
        span_id = tool.get("span_id") or _new_span_id()
        tool["span_id"] = span_id
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
        if "args" in tool:
            call["gen_ai.tool.call.arguments"] = tool["args"]
        call.update(tool.get("skill_attributes") or {})
        records.append(call)

        if tool.get("end_ns") is None:
            continue

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
        if "result" in tool:
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
    _install_legacy_system_observer()
    _TTFT_API.set(None)
    session_id = payload.get("session_id")
    if not isinstance(session_id, str) or not session_id:
        return
    state = _session(session_id)
    history = payload.get("conversation_history")
    state["model"] = payload.get("model") or state.get("model")
    state["platform"] = payload.get("platform") or state.get("platform")
    turn = _new_turn(
        session_id,
        payload.get("user_message", ""),
        payload.get("sender_id", ""),
        payload.get("turn_id", ""),
    )
    if isinstance(history, list) and history:
        # pre_llm_call observes the new turn boundary. A preceding assistant is
        # already history; an empty snapshot leaves the boundary unknown.
        last = history[-1]
        turn["history_start"] = len(history) - 1 if isinstance(last, dict) and last.get("role") == "user" else len(history)
    messages = _current_turn_messages(turn, payload)
    _capture_turn_input(turn, messages)
    turn["initial_messages"] = _bounded_value(messages)
    _remember_turn(state, turn, payload)


def _handle_pre_api_request(now_ns: int, payload: Dict[str, Any]) -> None:
    _TTFT_API.set(None)
    session_id = payload.get("session_id")
    if not isinstance(session_id, str) or not session_id:
        return
    state = _session(session_id)
    turn = _find_turn(state, payload)
    observer_turn_id = payload.get("turn_id")
    if turn is None:
        user_message = payload.get("user_message", "")
        turn = _new_turn(session_id, user_message,
                         payload.get("sender_id", ""), observer_turn_id)
    elif isinstance(observer_turn_id, str) and observer_turn_id:
        turn["observer_turn_id"] = observer_turn_id
    if not turn.get("user_message") and isinstance(payload.get("user_message"), str):
        turn["user_message"] = payload["user_message"]
        _capture_turn_input(turn, [{"role": "user", "content": payload["user_message"]}])
    _remember_turn(state, turn, payload)
    task_id = payload.get("task_id")
    state["model"] = payload.get("model") or state.get("model")
    state["platform"] = payload.get("platform") or state.get("platform")
    api = {
        "session_id": session_id,
        "task_id": task_id,
        "api_request_id": payload.get("api_request_id"),
        "api_call_count": payload.get("api_call_count"),
        "pre_ns": now_ns,
        "post_ns": None,
        "pre": {
            "provider": payload.get("provider"),
            "model": payload.get("model"),
            "tool_definitions": _tool_definitions(payload.get("request")),
            "system_instructions": _request_system_instructions(payload),
        },
        "post": {},
    }
    turn["apis"].append(api)
    _emit_request(turn, state, api, payload)
    try:
        api["started_perf_ns"] = time.perf_counter_ns()
        _install_first_delta_observer()
        _TTFT_API.set(api)
    except Exception:
        pass


def _handle_post_api_request(now_ns: int, payload: Dict[str, Any]) -> None:
    _TTFT_API.set(None)
    session_id = payload.get("session_id")
    if not isinstance(session_id, str) or not session_id:
        return
    state = _session(session_id)
    turn = _find_turn(state, payload)
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
    with _TTFT_LOCK:
        api["post_ns"] = now_ns
    api["post"] = {
        "provider": payload.get("provider"),
        "model": payload.get("model"),
        "response_model": payload.get("response_model"),
        "finish_reason": payload.get("finish_reason"),
        "usage": _bounded_value(payload.get("usage")),
    }
    response = payload.get("response")
    if isinstance(response, dict) and isinstance(response.get("assistant_message"), dict):
        api["post"]["assistant_message"] = _bounded_value(response["assistant_message"])
    _write_new_records(turn, _build_records(turn, state, payload))


def _handle_api_request_error(now_ns: int, payload: Dict[str, Any]) -> None:
    _TTFT_API.set(None)
    session_id = payload.get("session_id")
    if not isinstance(session_id, str) or not session_id:
        return
    state = _session(session_id)
    turn = _find_turn(state, payload)
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
    with _TTFT_LOCK:
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
    _write_new_records(turn, _build_records(turn, state, payload))


def _handle_pre_tool_call(now_ns: int, payload: Dict[str, Any]) -> None:
    session_id = payload.get("session_id")
    call_id = payload.get("tool_call_id")
    if not isinstance(session_id, str) or not session_id or not isinstance(call_id, str) or not call_id:
        return
    state = _session(session_id)
    turn = _find_turn(state, payload)
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
            "span_id": _new_span_id(),
            "start_ns": now_ns,
            "end_ns": None,
            "api": turn["apis"][-1] if turn["apis"] else None,
            "skill_attributes": _skill_attributes(
                payload.get("tool_name"), payload.get("args")
            ),
        }
        tool["args"] = _bounded_value(payload.get("args"))
        turn["tools"][call_id] = tool
        _write_new_records(turn, _build_records(turn, state, payload))
    if payload.get("tool_name") == "delegate_task":
        _ACTIVE_DELEGATION.set((session_id, _turn_id(turn), call_id))


def _handle_post_tool_call(now_ns: int, payload: Dict[str, Any]) -> None:
    session_id = payload.get("session_id")
    call_id = payload.get("tool_call_id")
    if not isinstance(session_id, str) or not session_id or not isinstance(call_id, str) or not call_id:
        return
    state = _session(session_id)
    turn = _find_turn(state, payload)
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
    if "args" not in tool:
        tool["args"] = _bounded_value(payload.get("args"))
    tool["result"] = _bounded_value(_decode_json(payload.get("result")))
    tool["skill_attributes"] = _skill_attributes(
        tool.get("tool_name"), payload.get("args"), payload.get("result")
    ) or tool.get("skill_attributes", {})
    _write_new_records(turn, _build_records(turn, state, payload))


def _handle_post_llm_call(now_ns: int, payload: Dict[str, Any]) -> None:
    _TTFT_API.set(None)
    session_id = payload.get("session_id")
    if not isinstance(session_id, str) or not session_id:
        return
    state = _session(session_id)
    turn = _find_turn(state, payload)
    if turn is None:
        return
    state["model"] = payload.get("model") or state.get("model")
    state["platform"] = payload.get("platform") or state.get("platform")
    _flush_turn(state, turn, payload)


def _handle_on_session_end(now_ns: int, payload: Dict[str, Any]) -> None:
    _TTFT_API.set(None)
    session_id = payload.get("session_id")
    if not isinstance(session_id, str) or not session_id:
        return
    state = _SESSIONS.get(session_id)
    if state is None:
        return
    # Finish hooks must not adopt another invocation via _find_turn's legacy
    # same-thread fallback, including after the original turn was flushed.
    identifiers = {
        key: payload[key]
        for key in ("turn_id", "task_id")
        if isinstance(payload.get(key), str) and payload[key]
    }
    if identifiers:
        matches = [
            turn for turn in state["turns"].values()
            if all(turn["observer_turn_id" if key == "turn_id" else key] == value
                   for key, value in identifiers.items())
        ]
        turn = matches[0] if len(matches) == 1 else None
    elif state["turn_count"] == 1:
        # Preserve the original single-turn error fallback without treating a
        # surviving background turn as evidence of ownership.
        turn = _find_turn(state, payload)
    else:
        turn = None
    if turn is None or not any(api.get("post_ns") is not None for api in turn["apis"]):
        return
    _flush_turn(state, turn, payload)


def _handle_on_session_finalize(now_ns: int, payload: Dict[str, Any]) -> None:
    _TTFT_API.set(None)
    session_id = payload.get("session_id")
    if isinstance(session_id, str) and session_id:
        state = _SESSIONS.get(session_id)
        if state is not None:
            # A foreground finalize can precede background post_tool/post_llm.
            # Keep its history-bearing completion path; abandoned turns remain
            # bounded by MAX_ACTIVE_TURNS and MAX_SESSIONS.
            state["finalize_requested"] = True
            if not state["turns"]:
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
            if hook_name in ("pre_llm_call", "post_llm_call", "api_request_error",
                             "on_session_end", "on_session_finalize"):
                _clear_legacy_system_instructions()
            with _STATE_LOCK:
                _HANDLERS[hook_name](time.time_ns(), kwargs)
        except Exception as error:
            # Observability must never affect the Hermes conversation.
            _report_internal_error(hook_name, error)
            return None

    return callback


def register(ctx: Any) -> None:
    """Register synchronous Hermes lifecycle callbacks."""
    _install_delegate_context()
    _purge_old_logs()
    for hook_name in HOOKS:
        try:
            ctx.register_hook(hook_name, _safe_callback(hook_name))
        except Exception:
            continue


@atexit.register
def _flush_at_exit() -> None:
    """Best effort for abandoned turns once normal completion is no longer possible."""
    with _STATE_LOCK:
        for state in list(_SESSIONS.values()):
            for turn in list(state["turns"].values()):
                try:
                    # _flush_turn emits only APIs with a completion timestamp;
                    # missing history and unfinished tools cannot be recovered.
                    _flush_turn(state, turn, {})
                except Exception as error:
                    _report_internal_error("process exit flush", error)
        for state, turn in list(_EVICTED_TURNS.values()):
            try:
                _flush_turn(state, turn, {})
            except Exception as error:
                _report_internal_error("process exit eviction retry", error)
        _EVICTED_TURNS.clear()
        _SESSIONS.clear()
