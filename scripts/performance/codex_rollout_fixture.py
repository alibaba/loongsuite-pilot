"""Write synthetic raw Codex rollouts and validate separately collected JSONL."""

from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path, PurePosixPath
import uuid


LLM_EVENTS = ("llm.request", "llm.response")
TOOL_EVENTS = ("tool.call", "tool.result")
CORE_EVENTS = LLM_EVENTS + TOOL_EVENTS
USAGE = {
    "input_tokens": "input",
    "output_tokens": "output",
    "total_tokens": "total",
    "reasoning_output_tokens": "reasoning",
    "cache_read.input_tokens": "cached",
}


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def timestamp(at):
    return at.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def write_rows(path, rows, mode):
    data = "".join(encode(row) + "\n" for row in rows).encode("utf-8")
    with path.open(mode) as stream:
        stream.write(data)
    return len(data)


def record(at, kind, payload):
    return {"timestamp": timestamp(at), "type": kind, "payload": payload}


def build_turn(at, session, sequence, cwd):
    turn = str(uuid.uuid4())
    request_text = "Check synthetic Codex fixture %s." % turn
    final_text = "Completed synthetic Codex fixture %s." % turn
    tools = [
        {"name": "exec_command", "id": "call_" + uuid.uuid4().hex, "arg": "pwd", "result": cwd},
        {"name": "apply_patch", "id": "call_" + uuid.uuid4().hex,
         "arg": "*** Begin Patch\n*** End Patch", "result": "Done"},
    ]
    first_response_id = "fc_" + uuid.uuid4().hex
    model = "gpt-5.5"
    rows = []

    def add(kind, **payload):
        rows.append(record(at + timedelta(milliseconds=len(rows)), kind, payload))

    add("turn_context", turn_id=turn, model=model, cwd=cwd)
    add("event_msg", type="task_started", turn_id=turn)
    add("response_item", type="message", role="user",
        content=[{"type": "input_text", "text": request_text}])

    steps = []
    for index, (base_input, base_output) in enumerate(((100, 10), (120, 12), (130, 13))):
        input_tokens = base_input + sequence
        output_tokens = base_output + sequence % 11
        usage = {
            "input": input_tokens, "output": output_tokens,
            "total": input_tokens + output_tokens, "cached": 0, "reasoning": output_tokens - 1,
        }
        tool = tools[index] if index < len(tools) else None
        step = {"id": "%s:%s:s%d" % (session, turn, index + 1),
                "finish": "tool_call" if tool else "stop", "usage": usage, "tool": tool}
        if index == 0:
            step["response_id"] = first_response_id
            add("event_msg", type="agent_message", message="Inspect the script.", phase="commentary")
            add("response_item", type="function_call", id=first_response_id, call_id=tool["id"],
                name=tool["name"], arguments=encode({"cmd": tool["arg"]}))
            add("response_item", type="function_call_output", call_id=tool["id"], output=encode(tool["result"]))
        elif index == 1:
            add("event_msg", type="agent_message", message="Apply a focused patch.", phase="commentary")
            add("response_item", type="custom_tool_call", call_id=tool["id"], name=tool["name"], input=tool["arg"])
            add("response_item", type="custom_tool_call_output", call_id=tool["id"], output=tool["result"])
        else:
            add("event_msg", type="agent_message", message=final_text, phase="final")
        add("event_msg", type="token_count", info={"last_token_usage": {
            "input_tokens": input_tokens, "output_tokens": output_tokens,
            "cached_input_tokens": usage["cached"], "reasoning_output_tokens": usage["reasoning"],
            "total_tokens": usage["total"],
        }})
        steps.append(step)

    add("event_msg", type="task_complete", turn_id=turn, last_agent_message=final_text)
    expected = {"session": session, "turn": turn, "provider": "openai", "model": model,
                "request_text": request_text, "final_text": final_text, "steps": steps}
    return rows, expected


class CodexRolloutFixture:
    """Create headers before startup, then append complete turns after input readiness."""

    def __init__(self, round_directory, container_root="/bench", sessions=64):
        if sessions < 1:
            raise ValueError("fixture needs at least one session")
        self.root = Path(round_directory)
        self.container_root = PurePosixPath(container_root)
        self.home = self.root / "home"
        self.data = self.home / ".loongsuite-pilot"
        self.markers = self.data / "state/codex/transcript-wakeups"
        self.markers.mkdir(parents=True, exist_ok=False)
        (self.root / "workspace").mkdir(exist_ok=True)
        self.session_count = sessions
        self.sequence = 0
        self.expected = []
        self.raw_bytes = 0
        self.headers_bytes = 0
        self.sessions = []
        self.source_offsets = {}
        now = datetime.now(timezone.utc)
        directory = self.home / ".codex/sessions" / now.strftime("%Y/%m/%d")
        directory.mkdir(parents=True, exist_ok=True)
        for _ in range(sessions):
            session = str(uuid.uuid4())
            path = directory / ("rollout-%s-%s.jsonl" % (now.strftime("%Y-%m-%dT%H-%M-%S"), session))
            header = record(now, "session_meta", {"id": session, "model_provider": "openai"})
            self.source_offsets[session] = write_rows(path, [header], "xb")
            self.headers_bytes += self.source_offsets[session]
            self.sessions.append((session, path, now))

    def container_path(self, path):
        return str(self.container_root / PurePosixPath(path.relative_to(self.root).as_posix()))

    def append_turn(self, session_index):
        session, path, previous_at = self.sessions[session_index]
        at = max(datetime.now(timezone.utc), previous_at + timedelta(milliseconds=1))
        rows, expected = build_turn(at, session, self.sequence, str(self.container_root / "workspace"))
        written = write_rows(path, rows, "ab")
        self.raw_bytes += written
        self.source_offsets[session] += written
        expected["end_offset"] = self.source_offsets[session]
        self.sessions[session_index] = (session, path, at + timedelta(milliseconds=len(rows)))
        self.expected.append(expected)
        self.sequence += 1
        marker = {
            "session_id": session,
            "turn_id": expected["turn"],
            "transcript_path": self.container_path(path),
            "hook_event": "stop",
            "received_at": timestamp(datetime.now(timezone.utc)),
        }
        temporary = self.markers / (".%s.tmp" % session)
        write_rows(temporary, [marker], "xb")
        temporary.replace(self.markers / (session + ".json"))
        return expected


def require(valid, label, detail):
    if not valid:
        raise ValueError("%s: %s" % (label, detail))


def nonempty(value):
    return isinstance(value, str) and bool(value.strip()) and value.strip() != "null"


def json_field(value):
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            pass
    return value


def text_in(messages, role, wanted):
    for message in messages:
        if not isinstance(message, dict) or message.get("role") != role:
            continue
        if message.get("content") == wanted:
            return True
        parts = message.get("parts")
        if not isinstance(parts, list):
            continue
        for part in parts:
            if isinstance(part, dict) and part.get("type") == "text" and part.get("content") == wanted:
                return True
    return False


def positive_nanos(value):
    if isinstance(value, str):
        if not 16 <= len(value) <= 20 or value.strip("0123456789"):
            return False
        value = int(value)
    return type(value) is int and 10 ** 15 <= value < 2 ** 64


def validate_output(rows, expected_turns, warm_count=None):
    """Validate independently expected source IDs, per-step metrics and joins."""
    expected = {(turn["session"], turn["turn"]): turn for turn in expected_turns}
    require(bool(expected) and len(expected) == len(expected_turns), "expected", "invalid turn manifest")
    expected_steps = {step["id"]: identity for identity, turn in expected.items() for step in turn["steps"]}
    expected_ends = {"%s:%s" % identity: identity for identity in expected}
    groups = defaultdict(dict)
    ends = set()
    ids = set()
    response_ids = set()
    counts = Counter()
    token_sums = Counter()
    auxiliary = set()
    delivered = set()

    for row in rows:
        require(isinstance(row, dict), "output", "expected a JSON object")
        event = row.get("event.name")
        require(event in CORE_EVENTS or event in ("other", "agent.input"), "output", "unexpected Codex event")
        label = row.get("event.id")
        require(nonempty(label) and label not in ids, repr(label), "missing or duplicate event id")
        ids.add(label)
        require(row.get("gen_ai.agent.type") == "codex", label, "incorrect agent type")
        require(nonempty(row.get("user.id")), label, "missing user id")
        require(positive_nanos(row.get("time_unix_nano")), label, "invalid event timestamp")
        if event in CORE_EVENTS:
            step_id = row.get("gen_ai.step.id")
            identity = expected_steps.get(step_id)
        else:
            identity = expected_ends.get(row.get("gen_ai.turn.id"))
        require(identity in expected, label, "unexpected session, turn or step")
        delivered.add(identity)
        session, turn_id = identity
        require(row.get("gen_ai.session.id") == session, label, "incorrect session id")
        require(row.get("gen_ai.turn.id") == "%s:%s" % identity, label, "incorrect normalized turn id")
        # JSONL strips the internal agent.codex.* fields. The public turn and
        # step IDs above still carry the complete source identity.
        if "agent.codex.transcript_turn_id" in row:
            require(row["agent.codex.transcript_turn_id"] == turn_id, label, "incorrect raw turn id")
        require(row.get("gen_ai.provider.name") == expected[identity]["provider"], label, "incorrect provider")
        if event in CORE_EVENTS:
            require(event not in groups[step_id], label, "duplicate %s for %s" % (event, step_id))
            groups[step_id][event] = row
            counts[event] += 1
        if row.get("gen_ai.turn.end") is True:
            require(event == "other" and identity not in ends, label, "duplicate or misplaced turn end")
            if "agent.codex.turn_status" in row:
                require(row["agent.codex.turn_status"] == "completed", label, "incorrect terminal status")
            ends.add(identity)
        elif event not in CORE_EVENTS:
            key = (identity, event)
            require(key not in auxiliary, label, "duplicate auxiliary event")
            messages = json_field(row.get("gen_ai.input.messages_delta"))
            require(isinstance(messages, list) and text_in(messages, "user", expected[identity]["request_text"]),
                    label, "incorrect auxiliary user message")
            if event == "other":
                require(row.get("gen_ai.turn.start") is True, label, "unexpected nonterminal other event")
            auxiliary.add(key)

    pending = []
    incomplete_sources = set()
    missing_responses = 0
    for turn_index, (identity, turn) in enumerate(expected.items()):
        terminal = identity in ends
        strict = warm_count is None or turn_index < warm_count or terminal
        require(identity not in delivered or turn["session"] not in incomplete_sources,
                turn["turn"], "gap in delivered Codex source prefix")
        previous_complete = True
        for index, step in enumerate(turn["steps"]):
            step_id = step["id"]
            events = groups[step_id]
            tool = step["tool"]
            names = CORE_EVENTS if tool else LLM_EVENTS
            observed = set(events)
            require(observed == set(names if strict else names[:len(observed)]),
                    step_id, "incomplete or unexpected step events: %s" % sorted(observed))
            require(not observed or previous_complete, step_id, "gap in delivered Codex step prefix")
            previous_complete = observed == set(names)
            request = events.get("llm.request")
            response = events.get("llm.response")
            if request:
                require(request.get("gen_ai.request.model") == turn["model"], step_id, "incorrect request model")
                response_id = request.get("gen_ai.response.id")
                require(nonempty(response_id) and response_id not in response_ids, step_id, "invalid response identity")
                if "response_id" in step:
                    require(response_id == step["response_id"], step_id, "lost source response id")
                response_ids.add(response_id)
                messages = json_field(request.get("gen_ai.input.messages_delta") or request.get("gen_ai.input.messages"))
                require(isinstance(messages, list) and bool(messages), step_id, "missing input messages")
                if index == 0:
                    require(text_in(messages, "user", turn["request_text"]), step_id, "incorrect user message")
            if response:
                require(response.get("gen_ai.response.model") == turn["model"], step_id, "incorrect response model")
                require(response.get("gen_ai.response.id") == response_id, step_id, "invalid request-response join")
                messages = json_field(response.get("gen_ai.output.messages"))
                require(isinstance(messages, list) and bool(messages), step_id, "missing output messages")
                require(json_field(response.get("gen_ai.response.finish_reasons")) == [step["finish"]],
                        step_id, "incorrect finish reason")
                if not tool:
                    require(text_in(messages, "assistant", turn["final_text"]), step_id, "incorrect final message")
                for field, key in USAGE.items():
                    value = response.get("gen_ai.usage." + field)
                    require(type(value) in (int, float) and value == step["usage"][key], step_id,
                            "incorrect %s token count %r" % (field, value))
                    token_sums[key] += value
            else:
                missing_responses += 1
            for name in TOOL_EVENTS:
                event = events.get(name)
                if not event:
                    continue
                require(event.get("gen_ai.tool.name") == tool["name"] and event.get("gen_ai.tool.call.id") == tool["id"],
                        step_id, "incorrect %s join" % name)
                if name == "tool.call":
                    arguments = json_field(event.get("gen_ai.tool.call.arguments"))
                    if isinstance(arguments, dict):
                        arguments = arguments.get("command", arguments.get("cmd"))
                    require(arguments == tool["arg"], step_id, "incorrect tool arguments")
                else:
                    result = json_field(event.get("gen_ai.tool.call.result"))
                    require(result == tool["result"], step_id, "incorrect tool result")
        if not terminal:
            require(not strict, turn["turn"], "missing terminal turn marker")
            pending.append(turn)
            incomplete_sources.add(turn["session"])

    result = {"turns": len(ends), "core_events": dict(counts), "turn_ends": len(ends),
              "tokens": dict(token_sums)}
    if warm_count is not None:
        result.update(turns=len(ends) - warm_count, pending=pending, missing_responses=missing_responses)
    return result
