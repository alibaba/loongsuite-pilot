"""Native QwenPaw telemetry: canonical JSONL, no tracer/exporter dependency.

Runtime hooks own requests. AgentScope middleware owns agent, reasoning,
model and tool execution. Context is attached only while advancing a stream,
so a suspended generator never leaves another request's context installed.
"""
from __future__ import annotations

import asyncio
import contextvars
from contextlib import contextmanager
import dataclasses
import functools
import inspect
import logging
import json
import os
import stat
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

try:
    from agentscope.middleware import MiddlewareBase
except ImportError:
    MiddlewareBase = object

_logger = logging.getLogger("loongsuite_pilot.qwenpaw")


def _get(value, key, default=None):
    try:
        return value.get(key, default) if isinstance(value, dict) else getattr(value, key, default)
    except (KeyError, AttributeError):
        return default


def _plain(value):
    dump = _get(value, "model_dump")
    if callable(dump):
        return _plain(dump())
    if dataclasses.is_dataclass(value):
        return {k: _plain(v) for k, v in dataclasses.asdict(value).items()}
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def _json_input(value):
    if isinstance(value, str):
        try:
            return json.loads(value)
        except (ValueError, TypeError):
            pass
    return _plain(value)


def _parts(content):
    if isinstance(content, str):
        return [{"type": "text", "content": content}]
    result = []
    for block in content or []:
        kind = _get(block, "type")
        if kind in ("text", "thinking"):
            result.append({"type": "text" if kind == "text" else "reasoning",
                           "content": _get(block, "text" if kind == "text" else "thinking", "")})
        elif kind == "tool_call":
            result.append({"type": "tool_call", "id": _get(block, "id"),
                           "name": _get(block, "name"), "arguments": _json_input(_get(block, "input"))})
        elif kind == "tool_result":
            result.append({"type": "tool_call_response", "id": _get(block, "id"),
                           "response": _tool_response_parts(_get(block, "output", _get(block, "content")))})
    return result


def _tool_response_parts(value):
    # Native ToolResultBlock lists contain blocks, whereas scalar/map results
    # are already application JSON and must retain their original shape.
    return _parts(value) if isinstance(value, (list, tuple)) else _plain(value)


def _skill_fields(agent, arguments):
    name = arguments.get("skill") if isinstance(arguments, dict) else None
    if not isinstance(name, str) or not name:
        return {}
    fields = {"gen_ai.skill.name": name, "gen_ai.skill.id": name}
    try:
        toolkit = _get(agent, "toolkit")
        metadata = dict((_get(toolkit, "_qp_skills", {}) or {}).get(name) or {})
        for group in _get(toolkit, "tool_groups", ()) or ():
            for loader in _get(group, "skills_or_loaders", ()) or ():
                cache = _get(loader, "_cache", {})
                candidates = [loader, *(cache.values() if isinstance(cache, dict) else ())]
                for skill in candidates:
                    if _get(skill, "name") == name:
                        for key in ("description", "dir"):
                            value = _get(skill, key)
                            if value:
                                metadata[key] = value
        directory = metadata.get("dir")
        if directory:
            from qwenpaw.agents.skill_system.store import read_skill_frontmatter_from_dir, extract_version
            skill_dir = Path(directory)
            post = read_skill_frontmatter_from_dir(skill_dir, name)
            metadata.setdefault("description", post.get("description"))
            version = extract_version(post)
            if not version:
                try:
                    manifest = json.loads((skill_dir.parent.parent / "skill.json").read_text(encoding="utf-8"))
                    version = manifest.get("skills", {}).get(name, {}).get("metadata", {}).get("version_text")
                except (OSError, ValueError, AttributeError):
                    pass
            if version:
                metadata["version"] = version
            parts = str(skill_dir).replace("\\", "/").split("/")
            workspace = "default"
            if "skills" in parts:
                index = len(parts) - 1 - parts[::-1].index("skills")
                if index > 0:
                    workspace = parts[index - 1]
            fields["gen_ai.skill.id"] = f"workspace:{workspace}:{name}"
        for key in ("description", "version"):
            if metadata.get(key):
                fields[f"gen_ai.skill.{key}"] = str(metadata[key])
    except Exception:
        pass
    return fields


def _messages(value, final=False, include_reasoning=True):
    values = value if isinstance(value, (list, tuple)) else [value]
    result = []
    for msg in values:
        if msg is None:
            continue
        parts = _parts(_get(msg, "content", []))
        if final:
            visible = []
            for part in parts:
                if part["type"] in ("tool_call", "tool_call_response"):
                    visible = []
                elif part["type"] == "text":
                    visible.append(part)
            parts = visible
        pending = []
        for part in parts:
            if part["type"] == "tool_call_response":
                if pending:
                    result.append({"role": _get(msg, "role", "assistant"), "parts": pending})
                    pending = []
                result.append({"role": "tool", "parts": [part]})
            elif include_reasoning or part["type"] != "reasoning":
                pending.append(part)
        if pending:
            result.append({"role": _get(msg, "role", "assistant"), "parts": pending})
    return result


def _usage(usage):
    fields = {}
    for name in ("input_tokens", "output_tokens"):
        value = _get(usage, name)
        if isinstance(value, (int, float)):
            fields[f"gen_ai.usage.{name}"] = value
    read = _get(usage, "cache_read_input_tokens")
    if read is None:
        read = _get(usage, "cache_input_tokens")
    created = _get(usage, "cache_creation_input_tokens")
    details = _get(usage, "prompt_tokens_details")
    if read is None:
        read = _get(details, "cached_tokens")
    if created is None:
        created = _get(details, "cache_creation_input_tokens")
    for value, name in ((read, "cache_read"), (created, "cache_creation")):
        if isinstance(value, (int, float)):
            fields[f"gen_ai.usage.{name}.input_tokens"] = value
    return fields


_PROVIDER_HOSTS = {
    "api.openai.com": "openai", "dashscope.aliyuncs.com": "dashscope",
    "dashscope-intl.aliyuncs.com": "dashscope", "dashscope-us.aliyuncs.com": "dashscope",
    "api.deepseek.com": "deepseek", "api.anthropic.com": "anthropic",
    "generativelanguage.googleapis.com": "gcp.gen_ai",
    "api.moonshot.cn": "moonshot", "api.moonshot.ai": "moonshot",
}
_PROVIDER_CLASSES = {
    "DashScopeChatModel": "dashscope", "OpenAIChatModel": "openai",
    "OpenAIResponseModel": "openai", "AnthropicChatModel": "anthropic",
    "GeminiChatModel": "gcp.gen_ai", "OllamaChatModel": "ollama",
    "DeepSeekChatModel": "deepseek", "MoonshotChatModel": "moonshot",
}
_PROVIDER_HINTS = {value: value for value in _PROVIDER_CLASSES.values()}
_PROVIDER_HINTS.update(bailian="dashscope", gemini="gcp.gen_ai")


def _provider_read(value, key):
    try:
        return _get(value, key)
    except Exception:
        # Optional metadata properties cannot break a business call.
        return None


def _provider(model):
    # Align with LoongSuite Python 83928b5. Resolve the active wrapped model
    # each call; configured fallback backends are not evidence of actual use.
    models, seen = [], set()
    for _ in range(8):
        if model is None or id(model) in seen:
            break
        seen.add(id(model))
        models.append(model)
        inner = _provider_read(model, "_inner")
        model = inner if inner is not None else _provider_read(model, "_model")
    has_endpoint = False
    for candidate in reversed(models):
        for source, key in ((_provider_read(candidate, "client"), "base_url"),
                            (_provider_read(candidate, "client_kwargs"), "base_url"),
                            (candidate, "base_url"),
                            (_provider_read(candidate, "credential"), "base_url"),
                            (candidate, "base_http_api_url")):
            value = _provider_read(source, key)
            if value is None or (isinstance(value, str) and not value):
                continue
            has_endpoint = True
            try:
                url = urlsplit(str(value))
                host = (url.hostname or "").lower().rstrip(".")
                if url.scheme in ("http", "https"):
                    for domain, provider in _PROVIDER_HOSTS.items():
                        if host == domain or host.endswith("." + domain):
                            return provider
            except Exception:
                pass
            # An explicit unknown proxy outranks stale wrapper endpoints.
            break
        if has_endpoint:
            break
    for candidate in reversed(models):
        for key in ("qwenpaw_provider_id", "_provider_id"):
            hint = _provider_read(candidate, key)
            if isinstance(hint, str) and hint.strip().lower() in _PROVIDER_HINTS:
                return _PROVIDER_HINTS[hint.strip().lower()]
    for candidate in reversed(models):
        for cls in type(candidate).__mro__:
            provider = _PROVIDER_CLASSES.get(cls.__name__)
            if provider and (not has_endpoint or provider == "ollama"):
                return provider
    return "unknown"


def _inherit(parent):
    return {key: value for key, value in parent.fields.items()
            if not key.startswith("gen_ai.tool.") and key not in ("gen_ai.step.id", "agent.qwenpaw.call.id")}


def _error(exc):
    if exc is None:
        return {}
    fields = {"error.type": type(exc).__name__, "error.message": str(exc)}
    if isinstance(exc, (asyncio.CancelledError, GeneratorExit)):
        fields["agent.qwenpaw.cancelled"] = True
    return fields


class JsonlWriter:
    """One private append per event; a broken sink cannot break an agent."""

    def __init__(self):
        self._lock = threading.Lock()

    def write(self, record):
        try:
            if os.getenv("LOONGSUITE_PILOT_ENABLED", "true").lower() in ("0", "false", "off"):
                return
            configured = os.getenv("LOONGSUITE_PILOT_DATA_DIR")
            if not configured:
                try:
                    marker = json.loads((Path(__file__).parent / ".loongsuite-pilot-managed.json").read_text())
                    configured = marker.get("dataDir")
                except (OSError, ValueError, TypeError):
                    pass
            root = Path(configured or str(Path.home() / ".loongsuite-pilot")).expanduser()
            try:
                config_path = Path(os.getenv("AGENT_DATA_COLLECTION_CONFIG") or root / "config.json").expanduser()
                config = json.loads(config_path.read_text())
                agent_config = (config.get("agents") or {}).get("qwenpaw") or {}
                if config.get("enabled") is False or agent_config.get("enabled") is False:
                    return
                outputs = [agent_config[key] if isinstance(agent_config.get(key), bool) else config.get(key)
                           for key in ("collectLog", "collectTrace")]
                if "qwenpaw" in (config.get("agents") or {}) and all(value is False for value in outputs):
                    return
                if agent_config.get("captureMessageContent") is False:
                    record = {key: value for key, value in record.items() if key not in (
                        "gen_ai.input.messages", "gen_ai.output.messages", "gen_ai.system_instructions",
                        "gen_ai.tool.definitions", "gen_ai.tool.call.arguments", "gen_ai.tool.call.result", "error.message")}
            except (OSError, ValueError, TypeError, AttributeError):
                pass
            directory = root / "logs" / "qwenpaw"
            with self._lock:
                directory.mkdir(parents=True, exist_ok=True, mode=0o700)
                if directory.is_symlink():
                    return
                directory.chmod(0o700)
                date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
                path = directory / f"qwenpaw-{date}-{os.getpid()}.jsonl"
                fd = os.open(path, os.O_APPEND | os.O_CREAT | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600)
                try:
                    if not stat.S_ISREG(os.fstat(fd).st_mode):
                        return
                    os.fchmod(fd, 0o600)
                    data = (json.dumps(record, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode()
                    # Lock covers partial writes too; each PID has its own file.
                    while data:
                        count = os.write(fd, data)
                        if count <= 0:
                            break
                        data = data[count:]
                finally:
                    os.close(fd)
        except Exception:
            pass


_writer = JsonlWriter()
_scope = contextvars.ContextVar("loongsuite_pilot_qwenpaw", default=None)
_CTX_KEY = "loongsuite_pilot_request"


@dataclasses.dataclass
class Scope:
    fields: dict
    started: int = dataclasses.field(default_factory=time.time_ns)
    output: list = dataclasses.field(default_factory=list)
    error: BaseException | None = None
    finish_reason: str | None = None
    step: "Scope | None" = None
    ended: bool = False
    round: int = 0
    parent: "Scope | None" = None
    owner: Any = None
    children: list = dataclasses.field(default_factory=list)
    finalizer: Any = None
    kind: str | None = None
    result: Any = None
    first: float | None = None
    monotonic_start: float = dataclasses.field(default_factory=time.monotonic)

    def __post_init__(self):
        self.root = self.parent.root if self.parent else self
        if self.parent and self.owner is None:
            self.owner = self.parent.owner
        if self.parent:
            self.root.children.append(self)
        parent = self.fields.get("agent.qwenpaw.span.id", "")
        self.fields = {**self.fields, "agent.qwenpaw.span.id": uuid.uuid4().hex[:16],
                       "agent.qwenpaw.parent.id": parent}


def _emit(name, scope, fields=None, timestamp=None):
    if scope is None or (scope.owner is not None and not scope.owner.active) or (scope.root.ended and scope is not scope.root):
        return
    try:
        now = str(timestamp or time.time_ns())
        record = {**scope.fields, **(fields or {}), "event.name": name,
                  "event.id": str(uuid.uuid4()), "time_unix_nano": now,
                  "observed_time_unix_nano": now, "gen_ai.agent.type": "qwenpaw"}
        _writer.write(record)
    except Exception:
        pass


def _boundary(scope, kind, end=False, extra=None):
    scope.kind = kind
    if end and scope.ended:
        return
    if end:
        scope.ended = True
        if isinstance(scope.error, (asyncio.CancelledError, GeneratorExit)):
            scope.finish_reason = "interrupted"
    _emit("other", scope, {
        "agent.qwenpaw.boundary": f"{'entry' if kind == 'turn' else kind}.{'end' if end else 'start'}",
        **({"gen_ai.turn.end": True} if end and kind == "turn" else {}),
        "agent.qwenpaw.start_time_unix_nano": str(scope.started),
        **({"agent.qwenpaw.end_time_unix_nano": str(time.time_ns()),
            "gen_ai.output.messages": scope.output, **_error(scope.error),
            **({"response.finish_reasons": scope.finish_reason} if scope.finish_reason else {}),
            **({"gen_ai.response.time_to_first_token": round(scope.first * 1_000_000_000)} if scope.first is not None else {})} if end else {}),
        **(extra or {}),
    }, None if end else scope.started)


def _finish_call(scope, event, fields):
    if scope.ended:
        return
    scope.ended = True
    _emit(event, scope, fields)


def _finish_request(scope, error=None):
    if scope.ended:
        return
    scope.error = error or scope.error
    for child in reversed(scope.children):
        if child.ended:
            continue
        child.error = scope.error or child.error or GeneratorExit()
        try:
            if child.finalizer:
                child.finalizer(child.error)
            elif child.kind:
                _boundary(child, child.kind, True)
        except Exception:
            # Telemetry cleanup must never replace the runtime error.
            pass
    _boundary(scope, "turn", True)


async def _advance(iterator, scope):
    token = _scope.set(scope)
    try:
        return await iterator.__anext__()
    finally:
        _scope.reset(token)


async def _close(iterator, scope):
    close = getattr(iterator, "aclose", None)
    if close:
        token = _scope.set(scope)
        try:
            await close()
        finally:
            _scope.reset(token)


class PilotMiddleware(MiddlewareBase):
    _loongsuite_pilot = True

    def __init__(self, request_scope=None, owner=None):
        self.request_scope = request_scope
        self.owner = owner
        self.replies = {}

    def _active(self):
        return self.owner is None or self.owner.active

    @contextmanager
    def _observe(self):
        """Guard telemetry only; never place a business call inside this block."""
        try:
            yield
        except Exception:
            if self.owner is not None:
                self.owner._diagnose("middleware observation")

    async def on_reply(self, agent, input_kwargs, next_handler):
        if not self._active():
            async for item in next_handler(**input_kwargs):
                yield item
            return
        try:
            parent = _scope.get() or self.request_scope
            if parent and parent.root.ended:
                parent = None
            owned = parent is None
            if owned:
                session = str(_get(_get(agent, "state"), "session_id") or uuid.uuid4())
                parent = Scope({"gen_ai.session.id": session, "gen_ai.conversation.id": session,
                                "gen_ai.turn.id": str(uuid.uuid4()), "agent.qwenpaw.entry.id": str(uuid.uuid4())}, owner=self.owner)
                _boundary(parent, "turn")
            scope = Scope({**_inherit(parent), "agent.qwenpaw.parent_agent.id": parent.fields.get("agent.qwenpaw.agent.id", ""),
                           "agent.qwenpaw.agent.id": str(uuid.uuid4()), "gen_ai.agent.name": str(parent.fields.get("agent.qwenpaw.dream.owner") or _get(agent, "name", "agent"))}, parent=parent)
            parent.root.fields.setdefault("gen_ai.agent.name", scope.fields["gen_ai.agent.name"])
            model = _get(agent, "model")
            scope.fields.update({"gen_ai.provider.name": _provider(model),
                                 "gen_ai.request.model": str(_get(model, "model", "unknown"))})
            # A session identifies a conversation, not a stable business Agent.
            _boundary(scope, "agent", extra={"gen_ai.input.messages": _messages(input_kwargs.get("inputs")),
                                             "gen_ai.system_instructions": [{"type": "text", "content": _get(agent, "_system_prompt", "")}]})
            self.replies[id(agent)] = scope
        except Exception:
            if self.owner is not None:
                self.owner._diagnose("middleware setup")
            async for item in next_handler(**input_kwargs):
                yield item
            return
        iterator = next_handler(**input_kwargs).__aiter__()
        started, first = time.monotonic(), None
        partial_text = ""
        try:
            while True:
                try:
                    item = await _advance(iterator, scope)
                except StopAsyncIteration:
                    break
                with self._observe():
                    if first is None and str(_get(item, "type", "")).lower() in ("text_block_delta", "thinking_block_delta", "tool_call_delta"):
                        first = round((time.monotonic() - started) * 1_000_000_000)
                        if scope.root.first is None:
                            scope.root.first = time.monotonic() - scope.root.monotonic_start
                    if parent is scope.root:
                        event_type = str(_get(item, "type", "")).lower()
                        if event_type == "tool_call_start":
                            partial_text = ""
                        elif event_type == "text_block_delta":
                            delta = _get(item, "delta")
                            if isinstance(delta, str) and delta:
                                partial_text += delta
                                # ENTRY reflects observed user-visible text even
                                # when cancellation prevents a final assistant Msg.
                                # AGENT still requires its actual completed Msg.
                                scope.root.output = [{"role": "assistant", "parts": [{"type": "text", "content": partial_text}]}]
                    if _get(item, "role") == "assistant" and _get(item, "content") is not None:
                        scope.output = _messages(item, final=True)
                        parent.output = scope.output
                        scope.fields.update(_usage(_get(item, "usage")))
                        if scope.root.first is None and scope.output:
                            scope.root.first = time.monotonic() - scope.root.monotonic_start
                    if str(_get(item, "finished_reason", "")) == "interrupted":
                        scope.error = asyncio.CancelledError()
                        parent.error = scope.error
                yield item
        except BaseException as exc:
            scope.error = exc
            parent.error = exc
            raise
        finally:
            try:
                await _close(iterator, scope)
            finally:
                with self._observe():
                    if scope.step:
                        scope.step.error = scope.error
                        _boundary(scope.step, "step", True)
                    _boundary(scope, "agent", True, {"gen_ai.response.time_to_first_token": first} if first is not None else {})
                if self.replies.get(id(agent)) is scope:
                    self.replies.pop(id(agent), None)
                if owned:
                    with self._observe():
                        _finish_request(parent)

    async def on_reasoning(self, agent, input_kwargs, next_handler):
        if not self._active():
            async for item in next_handler(**input_kwargs):
                yield item
            return
        reply = self.replies.get(id(agent)) or _scope.get()
        if reply is None:
            async for item in next_handler(**input_kwargs):
                yield item
            return
        try:
            if reply.step:
                _boundary(reply.step, "step", True)
            step_id = str(uuid.uuid4())
            step = Scope({**reply.fields, "agent.qwenpaw.reasoning.id": step_id}, parent=reply)
            reply.round += 1
            step.fields["agent.qwenpaw.reasoning.round"] = reply.round
            reply.step = step
            _boundary(step, "step")
        except Exception:
            if self.owner is not None:
                self.owner._diagnose("middleware setup")
            async for item in next_handler(**input_kwargs):
                yield item
            return
        iterator = next_handler(**input_kwargs).__aiter__()
        try:
            while True:
                try:
                    item = await _advance(iterator, step)
                except StopAsyncIteration:
                    break
                with self._observe():
                    if str(_get(item, "type", "")).lower() in ("tool_call", "tool_call_start", "tool_call_delta", "tool_call_end"):
                        step.finish_reason = "tool_calls"
                    elif _get(item, "role") and step.finish_reason != "tool_calls":
                        step.finish_reason = "stop"
                yield item
        except BaseException as exc:
            step.error = exc
            with self._observe():
                _boundary(step, "step", True)
            raise
        finally:
            await _close(iterator, step)
            # A ReAct step includes acting after reasoning. Close it at the
            # next reasoning start or reply end, not when this iterator ends.

    async def on_model_call(self, agent, input_kwargs, next_handler):
        if not self._active():
            return await next_handler(**input_kwargs)
        parent = _scope.get() or self.request_scope
        if parent is None:
            return await next_handler(**input_kwargs)
        try:
            model = input_kwargs.get("current_model") or _get(agent, "model")
            call_id = str(uuid.uuid4())
            call = Scope({**parent.fields, "agent.qwenpaw.call.id": call_id, "gen_ai.step.id": call_id,
                          "gen_ai.request.model": str(_get(model, "model", "unknown")),
                          "gen_ai.provider.name": _provider(model)}, parent=parent)
            request = {"gen_ai.input.messages": _messages(input_kwargs.get("messages"),
                           include_reasoning=_get(_get(model, "formatter"), "supports_thinking_input", True)),
                       "gen_ai.system_instructions": [{"type": "text", "content": _get(agent, "_system_prompt", "")}],
                       "gen_ai.tool.definitions": _plain(input_kwargs.get("tools", []))}
            for key in ("temperature", "top_p", "max_tokens"):
                value = input_kwargs.get(key, _get(_get(model, "parameters"), key))
                if value is not None:
                    request[f"gen_ai.request.{key}"] = value
            call.finalizer = lambda error: self._model_end(call, call.result, call.first, error)
            _emit("llm.request", call, request, call.started)
            started = time.monotonic()
        except Exception:
            if self.owner is not None:
                self.owner._diagnose("middleware setup")
            return await next_handler(**input_kwargs)
        try:
            result = await next_handler(**input_kwargs)
        except BaseException as exc:
            with self._observe():
                self._model_end(call, None, None, exc)
            raise
        try:
            streaming = callable(_get(result, "__aiter__"))
        except Exception:
            # Introspection is observational; return the actual business result.
            return result
        if not streaming:
            with self._observe():
                self._model_end(call, result, None, None)
            return result

        async def stream():
            last, first, error = None, None, None
            iterator = result.__aiter__()
            try:
                while True:
                    try:
                        chunk = await _advance(iterator, call)
                    except StopAsyncIteration:
                        break
                    with self._observe():
                        if first is None and any(p.get("content") or p.get("name") or p.get("arguments") for p in _parts(_get(chunk, "content", []))):
                            first = time.monotonic() - started
                        last = chunk
                        call.result, call.first = last, first
                    yield chunk
            except BaseException as exc:
                error = exc
                raise
            finally:
                try:
                    await _close(iterator, call)
                finally:
                    with self._observe():
                        self._model_end(call, last, first, error)
        return stream()

    def _model_end(self, call, response, first, error):
        if isinstance(error, GeneratorExit) and _get(response, "is_last", False):
            error = None
        fields = _error(error)
        if response is not None:
            parts = _parts(_get(response, "content", []))
            reason = "tool_calls" if any(p["type"] == "tool_call" for p in parts) else "stop"
            if str(_get(response, "finished_reason", "")) == "interrupted" or isinstance(error, (asyncio.CancelledError, GeneratorExit)):
                fields.update(_error(asyncio.CancelledError()))
                reason = "interrupted"
            elif error is not None:
                reason = "error"
            fields.update({"gen_ai.output.messages": [{"role": "assistant", "parts": parts, "finish_reason": reason}],
                           "response.finish_reasons": reason, "gen_ai.response.id": str(_get(response, "id", ""))})
            fields.update(_usage(_get(response, "usage")))
        if first is not None:
            fields["gen_ai.response.time_to_first_token"] = round(first * 1_000_000_000)
        _finish_call(call, "llm.response", fields)

    async def on_acting(self, agent, input_kwargs, next_handler):
        if not self._active():
            async for item in next_handler(**input_kwargs):
                yield item
            return
        try:
            reply = self.replies.get(id(agent))
            parent = (reply.step or reply) if reply else (_scope.get() or self.request_scope)
            tool = input_kwargs.get("tool_call")
            call = Scope({**(parent.fields if parent else {}), "gen_ai.tool.call.id": str(_get(tool, "id") or uuid.uuid4()),
                          "gen_ai.tool.name": str(_get(tool, "name", "unknown")),
                          "gen_ai.tool.call.arguments": _json_input(_get(tool, "input")),
                          "gen_ai.tool.type": "function"}, parent=parent, owner=self.owner)
            arguments = call.fields["gen_ai.tool.call.arguments"]
            if call.fields["gen_ai.tool.name"].lower() == "skill":
                call.fields.update(_skill_fields(agent, arguments))
            call.finalizer = lambda error: self._tool_end(call, call.result, error)
            _emit("tool.call", call, timestamp=call.started)
            started, last, error = time.monotonic(), None, None
        except Exception:
            if self.owner is not None:
                self.owner._diagnose("middleware setup")
            async for item in next_handler(**input_kwargs):
                yield item
            return
        iterator = next_handler(**input_kwargs).__aiter__()
        try:
            while True:
                try:
                    last = await _advance(iterator, call)
                except StopAsyncIteration:
                    break
                call.result = last
                yield last
        except BaseException as exc:
            error = exc
            raise
        finally:
            try:
                await _close(iterator, call)
            finally:
                with self._observe():
                    self._tool_end(call, last, error)

    def _tool_end(self, call, last, error):
        state = str(_get(last, "state", ""))
        # Native execution can return a terminal ToolChunk on failure and
        # immediately close the stream; preserve its actual failure reason.
        if isinstance(error, GeneratorExit) and (type(last).__name__ == "ToolResponse" or state in ("error", "denied", "interrupted", "success")):
            error = None
        fields = {"gen_ai.tool.call.result": _parts(_get(last, "content", [])),
                  "gen_ai.tool.call.duration": (time.monotonic() - call.monotonic_start) * 1000,
                  "tool.result.status": "error" if error or state in ("error", "denied", "interrupted") else "success",
                  **_error(error or (asyncio.CancelledError() if state == "interrupted" else None))}
        if state in ("error", "denied") and error is None:
            fields.update({"error.type": "ToolError" if state == "error" else "ToolDenied",
                           "error.message": "Tool returned an error" if state == "error" else "Tool was denied"})
        _finish_call(call, "tool.result", fields)



class PilotPlugin:
    def __init__(self):
        self.active = True
        self._original_init = None
        self._wrapped_init = None
        self._dream_patch = None
        self._agent_class = None
        self.diagnostics = []

    def _diagnose(self, capability):
        # No exception text, request data, or credentials enter diagnostics.
        if capability not in self.diagnostics:
            self.diagnostics.append(capability)
            _logger.warning("QwenPaw Pilot capability unavailable: %s", capability)

    def register(self, api):
        if getattr(self, "_registered", False):
            return
        try:
            from qwenpaw.runtime.hooks import HookBase, HookResult
            from qwenpaw.runtime.phases import Phase
            runtime_available = all(hasattr(Phase, key) for key in ("PRE_DISPATCH", "FINALLY")) and callable(getattr(api, "register_runtime_hook", None))
        except ImportError:
            runtime_available = False
            HookBase, HookResult = object, lambda: None
            Phase = type("UnavailablePhase", (), {"PRE_DISPATCH": None, "FINALLY": None})
        middleware_available = MiddlewareBase is not object and callable(getattr(api, "register_middleware", None)) and all(callable(getattr(MiddlewareBase, key, None)) for key in ("on_reply", "on_reasoning", "on_model_call", "on_acting"))
        # Cleanup callbacks are required before installing process-wide wrappers.
        cleanup_available = all(callable(getattr(api, key, None)) for key in ("register_shutdown_hook", "register_uninstall_hook"))
        self.active = True
        owner = self

        class Start(HookBase):
            name, phase, priority = "loongsuite_pilot_start", getattr(Phase, "PRE_DISPATCH", None), 1

            async def run(self, ctx):
                if not owner.active:
                    return HookResult()
                try:
                    request = ctx.request
                    session = str(ctx.session_id)
                    scope = Scope({"gen_ai.session.id": session, "gen_ai.conversation.id": session,
                                   "gen_ai.turn.id": str(_get(request, "id") or uuid.uuid4()),
                                   "agent.qwenpaw.entry.id": str(uuid.uuid4()), "user.id": str(_get(request, "user_id", "")),
                                   "agent.qwenpaw.runtime_agent.id": str(_get(ctx, "agent_id", ""))}, owner=owner)
                    extras = ctx.extras
                    if not isinstance(extras, dict):
                        raise TypeError("unsupported extras")
                    # Runtime hooks can bracket a suspended generator in another
                    # task. Carry scope explicitly; middleware attaches it only
                    # while advancing native execution, never across a yield.
                    extras[_CTX_KEY] = (scope, None)
                    # Content conversion is optional telemetry. Preserve the
                    # native request identity even when a message cannot map.
                    fields = {}
                    try:
                        fields["gen_ai.input.messages"] = _messages(_get(request, "input", []))
                    except Exception:
                        owner._diagnose("runtime request messages")
                    _boundary(scope, "turn", extra=fields)
                except Exception:
                    owner._diagnose("runtime request context")
                return HookResult()

        class Complete(HookBase):
            # Response generation (including normal persistence hooks) is done
            # before Runtime yields the terminal envelope. Consumers may stop
            # there without advancing the generator into FINALLY.
            name, phase, priority = "loongsuite_pilot_complete", getattr(Phase, "POST_RESPONSE", None), 10000

            async def run(self, ctx):
                if not owner.active:
                    return HookResult()
                try:
                    extras = _get(ctx, "extras", {})
                    state = extras.get(_CTX_KEY) if isinstance(extras, dict) else None
                    if state:
                        _finish_request(state[0], _get(ctx, "error"))
                except Exception:
                    owner._diagnose("runtime response completion")
                return HookResult()

        class Finish(HookBase):
            name, phase, priority = "loongsuite_pilot_finish", getattr(Phase, "FINALLY", None), 99

            async def run(self, ctx):
                extras = _get(ctx, "extras", {})
                state = extras.pop(_CTX_KEY, None) if isinstance(extras, dict) else None
                if state:
                    scope, token = state
                    try:
                        error = _get(ctx, "error")
                        if scope.ended and error is not None and scope.error is None:
                            # An already exported response-completion span cannot
                            # represent failures in later host hooks/envelope IO.
                            owner._diagnose("runtime failure after response completion")
                        _finish_request(scope, error)
                    except Exception:
                        owner._diagnose("runtime request cleanup")
                    try:
                        if token is not None:
                            _scope.reset(token)
                    except ValueError:
                        # Runtime may close a suspended async generator in a
                        # different task; its copied context dies with that task.
                        if _scope.get() is scope:
                            _scope.set(None)
                return HookResult()

        def middleware_factory(ctx, agent_config):
            if not owner.active:
                return None
            extras = _get(ctx, "extras", {})
            state = extras.get(_CTX_KEY) if isinstance(extras, dict) else None
            return PilotMiddleware(state[0] if state else None, owner=owner)

        # Retrying a partly registered API would duplicate hooks that have no
        # public unregister counterpart. A new plugin instance may retry.
        self._registered = True
        try:
            if cleanup_available:
                api.register_shutdown_hook("loongsuite_pilot_restore", self.shutdown)
                api.register_uninstall_hook("loongsuite_pilot_restore", self.shutdown)
            if runtime_available:
                api.register_runtime_hook(Start())
                api.register_runtime_hook(Finish())
                if hasattr(Phase, "POST_RESPONSE"):
                    api.register_runtime_hook(Complete())
                else:
                    self._diagnose("response completion hook")
            else:
                self._diagnose("runtime hooks")
            if middleware_available:
                api.register_middleware(middleware_factory, priority=1)
            else:
                self._diagnose("AgentScope middleware")
            if middleware_available and cleanup_available:
                for name, attach in (("helper agents", self._attach_helpers), ("Dream", self._attach_dream)):
                    try:
                        if attach() is False:
                            self._diagnose(name)
                    except Exception:
                        self._diagnose(name)
            elif not cleanup_available:
                self._diagnose("wrapper cleanup callbacks")
            self._registered = True
        except Exception:
            # The public API has no hook-unregister operation. Already registered
            # callbacks become inert, and owned global patches are restored.
            self.active = False
            self._restore()
            self._diagnose("plugin registration")

    def _attach_helpers(self):
        from agentscope.agent import Agent
        if self._original_init is not None or getattr(Agent.__init__, "_loongsuite_pilot", False):
            return
        original = Agent.__init__
        signature = inspect.signature(original)
        parameter = signature.parameters.get("middlewares")
        if parameter is None or parameter.kind not in (inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.KEYWORD_ONLY):
            return False

        @functools.wraps(original)
        def wrapped(instance, *args, **kwargs):
            try:
                bound = signature.bind(instance, *args, **kwargs)
                middlewares = list(bound.arguments.get("middlewares") or [])
                if not any(getattr(m, "_loongsuite_pilot", False) for m in middlewares):
                    middlewares.insert(0, PilotMiddleware(owner=self))
                bound.arguments["middlewares"] = middlewares
            except Exception:
                self._diagnose("helper constructor arguments")
                return original(instance, *args, **kwargs)
            return original(*bound.args, **bound.kwargs)

        wrapped._loongsuite_pilot = True
        self._agent_class = Agent
        self._original_init, self._wrapped_init = original, wrapped
        Agent.__init__ = wrapped

    def _attach_dream(self):
        try:
            from qwenpaw.agents.memory.reme_light_memory_manager import ReMeLightMemoryManager
        except ImportError:
            return False
        original = getattr(ReMeLightMemoryManager, "dream", None)
        if not inspect.iscoroutinefunction(original):
            return False
        if getattr(original, "_loongsuite_pilot", False):
            return

        @functools.wraps(original)
        async def dream(instance, *args, **kwargs):
            try:
                owner = None
                try:
                    from qwenpaw.config.config import load_agent_config
                    name = load_agent_config(instance.agent_id).name or "QwenPaw"
                    if isinstance(name, str) and name.strip():
                        owner = name
                except Exception:
                    pass
                # A background job owns a fresh scope rather than inheriting a
                # completed request ContextVar copied by asyncio.create_task.
                session = str(kwargs.get("session_id") or f"dream:{_get(instance, 'agent_id', 'default')}")
                scope = Scope({"gen_ai.session.id": session, "gen_ai.conversation.id": session,
                               "gen_ai.turn.id": str(uuid.uuid4()), "agent.qwenpaw.entry.id": str(uuid.uuid4()),
                               "agent.qwenpaw.dream.owner": owner, "agent.qwenpaw.background": "dream"}, owner=self)
                _boundary(scope, "turn")
                token = _scope.set(scope)
            except Exception:
                self._diagnose("Dream setup")
                return await original(instance, *args, **kwargs)
            try:
                return await original(instance, *args, **kwargs)
            except BaseException as exc:
                scope.error = exc
                raise
            finally:
                try:
                    _finish_request(scope)
                except Exception:
                    self._diagnose("Dream finalization")
                finally:
                    _scope.reset(token)

        dream._loongsuite_pilot = True
        ReMeLightMemoryManager.dream = dream
        self._dream_patch = (ReMeLightMemoryManager, original, dream)

    async def shutdown(self, **_kwargs):
        self.active = False
        self._restore()

    def _restore(self):
        if self._wrapped_init is not None and self._agent_class.__init__ is self._wrapped_init:
            self._agent_class.__init__ = self._original_init
        self._original_init = self._wrapped_init = None
        if self._dream_patch:
            cls, original, wrapped = self._dream_patch
            if cls.dream is wrapped:
                cls.dream = original
            self._dream_patch = None


plugin = PilotPlugin()
