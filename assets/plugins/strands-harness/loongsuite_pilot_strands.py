"""LoongSuite Pilot sidecar collection for the Strands Agents Python SDK."""

import asyncio
import json
import logging
import math
import os
import queue
import sqlite3
import tempfile
import threading
import time
import uuid
from concurrent.futures import Future
from dataclasses import dataclass, field
from datetime import datetime
from itertools import groupby, islice
from pathlib import Path

from strands.hooks import (
    AfterInvocationEvent,
    AfterModelCallEvent,
    AfterToolCallEvent,
    BeforeInvocationEvent,
    BeforeModelCallEvent,
    BeforeToolCallEvent,
)
from strands.plugins import Plugin

_AGENT_TYPE = "strands-harness"
_MAX_TURN_BYTES = 1024 * 1024
_MAX_TURN_EVENTS = 512
_MAX_PENDING_TURNS = 16
_MAX_SEGMENTS = 2048
_MAX_MESSAGES = 16
_MAX_TEXT = 8192
_WRITE_WAIT_SECONDS = 0.15
_LOG = logging.getLogger(__name__)
_JOBS = queue.Queue(maxsize=_MAX_PENDING_TURNS)
_WORKER_LOCK = threading.Lock()
_WORKER_PID = None

_FINISH_REASONS = {
    "end_turn": "stop",
    "stop_sequence": "stop",
    "tool_use": "tool_calls",
    "max_tokens": "length",
    "content_filtered": "content_filter",
    "guardrail_intervened": "content_filter",
    "cancelled": "cancelled",
}
_USAGE = {
    "inputTokens": "gen_ai.usage.input_tokens",
    "outputTokens": "gen_ai.usage.output_tokens",
    "totalTokens": "gen_ai.usage.total_tokens",
    "cacheReadInputTokens": "gen_ai.usage.cache_read.input_tokens",
    "cacheWriteInputTokens": "gen_ai.usage.cache_creation.input_tokens",
}


def _reset_writer_after_fork():
    global _JOBS, _WORKER_LOCK, _WORKER_PID
    _JOBS = queue.Queue(maxsize=_MAX_PENDING_TURNS)
    _WORKER_LOCK = threading.Lock()
    _WORKER_PID = None


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_reset_writer_after_fork)


def _write_segment(target, rows):
    directory = target.parent
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if directory.is_symlink() or (os.name != "nt" and directory.stat().st_mode & 0o077):
        raise OSError("Strands Pilot log directory must be private")
    # Use the same OS transaction gate as Pilot retention. A completed segment
    # is immutable and can be reclaimed only after the collector's checkpoint.
    gate = sqlite3.connect(directory / ".raw-source-gate.sqlite", timeout=0.025)
    try:
        gate.execute("BEGIN IMMEDIATE")
        stale_before = time.time() - 600
        count = 0
        with os.scandir(directory) as entries:
            for entry in entries:
                if entry.name.startswith(_AGENT_TYPE + "-") and entry.name.endswith(".jsonl"):
                    count += 1
                    if count >= _MAX_SEGMENTS:
                        return False
                elif entry.name.startswith(".strands-") and entry.name.endswith(".tmp"):
                    if entry.stat(follow_symlinks=False).st_mtime < stale_before:
                        Path(entry.path).unlink(missing_ok=True)
        descriptor, name = tempfile.mkstemp(prefix=".strands-", suffix=".tmp", dir=directory)
        temporary = Path(name)
        try:
            with os.fdopen(descriptor, "wb") as output:
                output.writelines(rows)
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
        return True
    finally:
        gate.close()


def _run_writer():
    while True:
        target, rows, future = _JOBS.get()
        try:
            future.set_result(_write_segment(target, rows))
        except Exception:
            future.set_result(False)
        finally:
            _JOBS.task_done()
            del rows


def _submit(target, rows):
    global _WORKER_PID
    with _WORKER_LOCK:
        if _WORKER_PID is None:
            threading.Thread(target=_run_writer, name="loongsuite-pilot-strands", daemon=True).start()
            _WORKER_PID = os.getpid()
    future = Future()
    _JOBS.put_nowait((target, rows, future))
    return future


def _bounded_json(value, budget=None, depth=0):
    if budget is None:
        budget = [96]
    if not budget[0] or depth > 6:
        return None
    budget[0] -= 1
    if isinstance(value, str):
        return value[:_MAX_TEXT]
    if value is None or isinstance(value, (bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        output = {}
        for key, item in islice(value.items(), 32):
            if not budget[0]:
                break
            if isinstance(key, str):
                output[key[:256]] = _bounded_json(item, budget, depth + 1)
        return output
    if isinstance(value, (list, tuple)):
        output = []
        for item in islice(value, 32):
            if not budget[0]:
                break
            output.append(_bounded_json(item, budget, depth + 1))
        return output
    return None


def _message_parts(message):
    role = message.get("role")
    if role not in ("system", "user", "assistant", "tool"):
        return
    for block in islice(message.get("content", []), 16):
        if isinstance(block.get("text"), str):
            yield role, {"type": "text", "content": block["text"][:_MAX_TEXT]}
        elif "toolUse" in block:
            tool = block["toolUse"]
            yield role, {
                "type": "tool_call", "id": tool["toolUseId"], "name": tool["name"],
                "arguments": _bounded_json(tool.get("input")),
            }
        elif "toolResult" in block:
            tool = block["toolResult"]
            yield "tool", {
                "type": "tool_call_response", "id": tool["toolUseId"],
                "response": _bounded_json(tool.get("content")),
            }
        elif "reasoningContent" in block:
            text = block["reasoningContent"].get("reasoningText", {}).get("text")
            if isinstance(text, str):
                yield role, {"type": "reasoning", "content": text[:_MAX_TEXT]}


def _messages(messages):
    return [
        {"role": role, "parts": [part for _, part in parts]}
        for message in messages[-_MAX_MESSAGES:]
        for role, parts in groupby(_message_parts(message), key=lambda item: item[0])
    ]


def _with(name, value):
    return {name: value} if value is not None else {}


@dataclass
class _Turn:
    common: dict
    message_count: int
    message_anchor: str | None
    ident: str = field(default_factory=lambda: uuid.uuid4().hex)
    started: int = field(default_factory=time.time_ns)
    clock: int = field(default_factory=time.monotonic_ns)
    rows: dict = field(default_factory=dict)
    tools: dict = field(default_factory=dict)
    seq: int = 0
    size: int = 0
    round: int = 0
    active_model: int | None = None
    error_type: str | None = None
    model_name: str | None = None
    overflow: bool = False

    def now(self):
        return self.started + time.monotonic_ns() - self.clock

    def add(self, event, timestamp, fields, *, step=0, tool_id=""):
        if self.overflow:
            return
        key = (event, step, tool_id)
        data = {
            **self.common,
            "event.id": f"{self.ident}-{self.seq}",
            "event.name": event,
            "time_unix_nano": str(timestamp),
            "trace_id": self.ident,
            "gen_ai.turn.id": self.ident,
            **fields,
        }
        if step:
            data["gen_ai.step.id"] = f"{self.ident}:s{step}"
            data["gen_ai.react.round"] = step
        payload = (json.dumps(data, separators=(",", ":"), allow_nan=False) + "\n").encode()
        previous = self.rows.get(key)
        size = self.size + len(payload) - (len(previous[1]) if previous else 0)
        if size > _MAX_TURN_BYTES or (previous is None and len(self.rows) >= _MAX_TURN_EVENTS):
            self.overflow = True
            self.rows.clear()
            self.tools.clear()
            return
        self.size = size
        self.seq += 1
        self.rows[key] = (timestamp, payload)

    def segment(self, directory):
        date = datetime.fromtimestamp(self.started // 1_000_000_000).date()
        order = (self.started // 1_000_000) % 1_000_000_000_000
        target = directory / f"{_AGENT_TYPE}-{date}.segment-{order:012d}-{self.ident}.jsonl"
        return target, [payload for _, payload in sorted(self.rows.values(), key=lambda row: row[0])]


class PilotStrandsPlugin(Plugin):
    """Record a single Strands Agent's native lifecycle in Pilot's log directory."""

    name = "loongsuite-pilot"

    def __init__(self, *, session_id, provider, agent_id=None, data_dir=None, capture_content=True):
        super().__init__()
        if not isinstance(session_id, str) or not session_id.strip():
            raise ValueError("session_id is required")
        if not isinstance(provider, str) or not provider.strip():
            raise ValueError("provider is required")
        root = data_dir or os.environ.get("LOONGSUITE_PILOT_DATA_DIR") or "~/.loongsuite-pilot"
        self._directory = Path(root).expanduser().absolute() / "logs" / _AGENT_TYPE
        self._session_id = session_id
        self._agent_id = agent_id
        self._provider = provider
        self._capture_content = capture_content
        self._registered = False
        self._turns = {}
        self._warned = set()

    def init_agent(self, agent):
        # Harness may pass a consumer plugin instance down to its subagents.
        # The session binding belongs to the original agent.
        if self._registered:
            return
        self._registered = True
        for event in (
            BeforeInvocationEvent, BeforeModelCallEvent, AfterModelCallEvent,
            BeforeToolCallEvent, AfterToolCallEvent, AfterInvocationEvent,
        ):
            agent.hooks.add_callback(event, self._observe)

    def _warn_once(self, reason):
        if reason not in self._warned:
            self._warned.add(reason)
            _LOG.warning("Strands Pilot collection skipped: %s", reason)

    async def _observe(self, event):
        context = event.invocation_context
        if context is None:
            return
        try:
            if isinstance(event, BeforeInvocationEvent):
                self._start(event, context)
            elif isinstance(event, AfterInvocationEvent):
                turn = self._turns.pop(context, None)
                if turn:
                    await self._finish(turn, event)
            else:
                turn = self._turns.get(context)
                if not turn or turn.overflow:
                    return
                if isinstance(event, BeforeModelCallEvent):
                    self._before_model(turn, event)
                elif isinstance(event, AfterModelCallEvent):
                    self._after_model(turn, event)
                elif isinstance(event, BeforeToolCallEvent):
                    self._before_tool(turn, event)
                elif isinstance(event, AfterToolCallEvent):
                    self._after_tool(turn, event)
        except Exception:
            self._warn_once("hook or write failure")

    def _start(self, event, context):
        if context in self._turns or len(self._turns) >= _MAX_PENDING_TURNS:
            return
        agent = event.agent
        history = agent.messages
        turn = _Turn(
            {
                "gen_ai.agent.type": _AGENT_TYPE,
                "gen_ai.agent.system": "strands",
                "gen_ai.framework": "strands",
                "gen_ai.session.id": self._session_id,
                "gen_ai.provider.name": self._provider,
                **_with("gen_ai.agent.id", self._agent_id or agent.agent_id),
                **_with("gen_ai.agent.name", agent.name),
            },
            len(history),
            history[-1].get("tracking_id") if history else None,
        )
        content = _messages(event.messages or []) if self._capture_content else []
        turn.add("other", turn.started, {
            "gen_ai.turn.start": True,
            **({"gen_ai.input.messages": content} if content else {}),
        })
        self._turns[context] = turn

    def _before_model(self, turn, event):
        timestamp = turn.now()
        turn.round += 1
        turn.active_model = turn.round
        turn.error_type = None
        config = getattr(event.agent.model, "get_config", None)
        model = config().get("model_id") if callable(config) else None
        turn.model_name = model if isinstance(model, str) and model else None
        fields = _with("gen_ai.request.model", turn.model_name)
        if self._capture_content:
            history = event.agent.messages
            if len(history) <= _MAX_MESSAGES:
                fields["gen_ai.input.messages"] = _messages(history)
            count = turn.message_count
            anchor_matched = count == 0 or (
                count <= len(history) and turn.message_anchor is not None
                and history[count - 1].get("tracking_id") == turn.message_anchor
            )
            if anchor_matched and count < len(history):
                fields["gen_ai.input.messages_delta"] = _messages(history[max(count, len(history) - _MAX_MESSAGES):])
            turn.message_count = len(history)
            turn.message_anchor = history[-1].get("tracking_id") if history else None
            instructions = event.agent.system_prompt
            if instructions:
                fields["gen_ai.system_instructions"] = [{"type": "text", "content": instructions[:_MAX_TEXT]}]
        turn.add("llm.request", timestamp, fields, step=turn.round)

    def _after_model(self, turn, event):
        timestamp = turn.now()
        step = turn.active_model
        if step is None:
            return
        turn.active_model = None
        fields = _with("gen_ai.request.model", turn.model_name)
        if event.exception is not None:
            turn.error_type = type(event.exception).__name__
            fields["error.type"] = turn.error_type
        if event.stop_response is not None:
            message = event.stop_response.message
            finish = _FINISH_REASONS.get(event.stop_response.stop_reason)
            if finish:
                fields["gen_ai.response.finish_reasons"] = [finish]
            if self._capture_content:
                output = _messages([message])
                if output and finish:
                    output[-1]["finish_reason"] = finish
                if output:
                    fields["gen_ai.output.messages"] = output
            metadata = message.get("metadata") or {}
            usage = metadata.get("usage") or {}
            for native, canonical in _USAGE.items():
                value = usage.get(native)
                if type(value) is int and value >= 0:
                    fields[canonical] = value
            ttft = (metadata.get("metrics") or {}).get("timeToFirstByteMs")
            if type(ttft) is int and ttft > 0:
                fields["gen_ai.response.time_to_first_token"] = ttft * 1_000_000
        turn.add("llm.response", timestamp, fields, step=step)

    def _before_tool(self, turn, event):
        timestamp = turn.now()
        tool_id = event.tool_use.get("toolUseId")
        name = event.tool_use.get("name")
        if not turn.round or not isinstance(tool_id, str) or not tool_id or not isinstance(name, str) or not name:
            return
        fields = {
            "gen_ai.tool.call.id": tool_id,
            "gen_ai.tool.name": name,
            **_with("gen_ai.request.model", turn.model_name),
        }
        turn.tools[tool_id] = (turn.round, fields)
        call = dict(fields)
        if self._capture_content:
            call["gen_ai.tool.call.arguments"] = _bounded_json(event.tool_use.get("input"))
        turn.add("tool.call", timestamp, call, step=turn.round, tool_id=tool_id)

    def _after_tool(self, turn, event):
        timestamp = turn.now()
        tool_id = event.tool_use.get("toolUseId")
        seen = turn.tools.get(tool_id)
        if not seen:
            return
        step, common = seen
        status = "cancelled" if event.cancel_message else event.result.get("status")
        fields = {**common, **_with("tool.result.status", status)}
        if event.exception is not None:
            fields["error.type"] = type(event.exception).__name__
        duration = event.duration
        if isinstance(duration, (int, float)) and math.isfinite(duration) and duration > 0:
            fields["gen_ai.tool.call.duration"] = duration * 1000
        if self._capture_content:
            fields["gen_ai.tool.call.result"] = _bounded_json(event.result.get("content"))
        turn.add("tool.result", timestamp, fields, step=step, tool_id=tool_id)

    async def _finish(self, turn, event):
        if turn.overflow:
            self._warn_once("turn size limit")
            return
        if not turn.round:
            return
        fields = {"gen_ai.turn.end": True}
        if event.result is None and turn.error_type:
            fields["error.type"] = turn.error_type
        turn.add("other", turn.now(), fields, tool_id="end")
        if turn.overflow:
            self._warn_once("turn size limit")
            return
        target, rows = turn.segment(self._directory)
        try:
            result = await asyncio.wait_for(
                asyncio.shield(asyncio.wrap_future(_submit(target, rows))), _WRITE_WAIT_SECONDS,
            )
            if not result:
                self._warn_once("log write or disk limit")
        except queue.Full:
            self._warn_once("writer queue full")
        except TimeoutError:
            self._warn_once("log write is still pending")
