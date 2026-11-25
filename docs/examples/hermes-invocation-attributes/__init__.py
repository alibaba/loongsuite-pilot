"""Opt-in example for a Python caller that owns a Hermes 0.16.0 invocation."""

from contextlib import contextmanager
from contextvars import ContextVar
import json
import logging
import os
import subprocess

_request = ContextVar("pilot_invocation_attributes", default=None)
_log = logging.getLogger(__name__)


@contextmanager
def request_attributes(*, session_id, task_id, attributes):
    """Open in the executing worker, with a fresh task_id for this call."""
    scope = {"session": session_id, "task": task_id,
             "attributes_json": json.dumps(attributes, ensure_ascii=False, allow_nan=False),
             "registered_turn": None}
    token = _request.set(scope)
    try:
        yield
    finally:
        _request.reset(token)


def on_pre_llm_call(**event):
    request = _request.get()
    if request is None or event.get("session_id") != request["session"] or event.get("task_id") != request["task"]:
        return None
    turn = event.get("turn_id")
    cli = os.environ.get("PILOT_INVOCATION_ATTRIBUTE_CLI")
    if not cli or not isinstance(turn, str) or not turn or request["registered_turn"] == turn:
        return None
    payload = {
        "scope": os.environ.get("PILOT_INVOCATION_SCOPE", "agent-gateway"),
        "agent": "hermes",
        "invocationId": request["task"],
        "selector": {"kind": "turn", "sessionId": request["session"], "turnId": turn},
        "attributes": json.loads(request["attributes_json"]),
    }
    try:
        result = subprocess.run(
            [os.environ.get("PILOT_INVOCATION_NODE", "node"), cli, "register"],
            input=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=1,
            check=False,
        )
        if result.returncode == 0:
            request["registered_turn"] = turn
        else:
            _log.warning("Pilot invocation registration rejected")
    except (OSError, subprocess.TimeoutExpired):
        _log.warning("Pilot invocation registration unavailable")
    # A string or context return value would augment the model's prompt.
    return None


def register(ctx):
    ctx.register_hook("pre_llm_call", on_pre_llm_call)
