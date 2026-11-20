#!/usr/bin/env python3
"""Generate synthetic ZCode rollout fixtures (replaces real captured data).

The tests only depend on: line counts, tool-call topology, ID consistency,
timestamp ordering, and the three hardcoded IDs of the paired fixture. All
prompts/headers/paths/env details are replaced with synthetic placeholders.
"""
import json
import os
import uuid

FIXTURE_DIR = os.path.join(os.path.dirname(__file__), '..', 'tests', 'unit', 'hooks', 'zcode', 'fixtures')


def deterministic_uuid(seed: int) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"zcode-synthetic-fixture-{seed}"))


def make_tool_call(seed: int, name: str, arg_desc: str):
    return {
        "id": f"call_{deterministic_uuid(seed)[:24]}",
        "name": name,
        "input": {"description": arg_desc, "placeholder": True},
    }


def make_tool_message(seed: int, call_id: str, name: str, content: str, is_error=False):
    return {
        "role": "tool",
        "toolCallId": call_id,
        "toolName": name,
        "content": content,
        "isError": is_error,
        "_synthetic": True,
    }


def make_line(*, session_id, turn_id, trace_id, request_id, seq, started_at, completed_at,
              input_messages, tool_calls, finish_reason, text, usage=None):
    tool_names = sorted({tc["name"] for tc in tool_calls}) if tool_calls else []
    return {
        "type": "model_io",
        "sessionId": session_id,
        "turnId": turn_id,
        "traceId": trace_id,
        "requestId": request_id,
        "attempt": 1,
        "querySource": "main_turn",
        "startedAt": started_at,
        "completedAt": completed_at,
        "durationMs": 1000 + seq,
        "model": {"modelId": "synthetic-model", "providerId": "synthetic-provider", "role": "main", "source": "config"},
        "request": {
            "messages": input_messages,
            "toolNames": tool_names,
            "messageCount": len(input_messages),
            "messagesKind": "full",
            "messageOffset": 0,
        },
        "response": {
            "finishReason": finish_reason,
            "modelId": "synthetic-model",
            "responseId": f"chatcmpl-synthetic-{seq}",
            "text": text,
            "toolCalls": tool_calls,
            "usage": usage or {"inputTokens": 100, "outputTokens": 20, "totalTokens": 120, "cacheReadTokens": 0},
        },
    }


def write_fixture(name, lines):
    path = os.path.join(FIXTURE_DIR, name)
    with open(path, "w") as f:
        for line in lines:
            f.write(json.dumps(line) + "\n")
    print(f"wrote {name}: {len(lines)} lines, {os.path.getsize(path)} bytes")


USER_MSG = {"role": "user", "content": "synthetic user prompt"}
SYSTEM_MSG = {"role": "system", "content": "synthetic system prompt"}
ASSISTANT_MSG = {"role": "assistant", "content": "synthetic assistant reply"}

# ─── 1. rollout-model-io-paired.jsonl — single line, hardcoded paired IDs ───
write_fixture("rollout-model-io-paired.jsonl", [
    make_line(
        session_id="sess_36734977-639d-4424-94ba-8c1957576a5f",
        turn_id="turn_b8638fe6-b763-4258-9b91-660d2f8edaef",
        trace_id="e294f5ce-30c2-4817-92be-d035412905a1",
        request_id=deterministic_uuid(101),
        seq=0,
        started_at="2026-07-13T02:39:25.447Z",
        completed_at="2026-07-13T02:39:27.370Z",
        input_messages=[SYSTEM_MSG, USER_MSG],
        tool_calls=[],
        finish_reason="stop",
        text="hello",
    ),
])

# ─── 2. rollout-multi-line-react.jsonl — 3 lines: 2 toolCalls → 1 toolCall → stop ───
ml_session = f"sess_{deterministic_uuid(201)}"
ml_turn = f"turn_{deterministic_uuid(202)}"
ml_trace = deterministic_uuid(203)
ml_tc0a = make_tool_call(211, "Bash", "synthetic tool A")
ml_tc0b = make_tool_call(212, "Read", "synthetic tool B")
ml_tc1 = make_tool_call(213, "Grep", "synthetic tool C")
write_fixture("rollout-multi-line-react.jsonl", [
    make_line(
        session_id=ml_session, turn_id=ml_turn, trace_id=ml_trace,
        request_id=deterministic_uuid(221), seq=0,
        started_at="2026-07-13T04:02:59.363Z", completed_at="2026-07-13T04:03:06.774Z",
        input_messages=[SYSTEM_MSG, USER_MSG],
        tool_calls=[ml_tc0a, ml_tc0b], finish_reason="tool-calls",
        text="synthetic step 0 text",
    ),
    make_line(
        session_id=ml_session, turn_id=ml_turn, trace_id=ml_trace,
        request_id=deterministic_uuid(222), seq=1,
        started_at="2026-07-13T04:03:08.000Z", completed_at="2026-07-13T04:03:12.000Z",
        input_messages=[
            SYSTEM_MSG, USER_MSG, ASSISTANT_MSG,
            make_tool_message(231, ml_tc0a["id"], ml_tc0a["name"], "synthetic result A"),
            make_tool_message(232, ml_tc0b["id"], ml_tc0b["name"], "synthetic result B"),
        ],
        tool_calls=[ml_tc1], finish_reason="tool-calls",
        text="synthetic step 1 text",
    ),
    make_line(
        session_id=ml_session, turn_id=ml_turn, trace_id=ml_trace,
        request_id=deterministic_uuid(223), seq=2,
        started_at="2026-07-13T04:03:14.000Z", completed_at="2026-07-13T04:03:16.000Z",
        input_messages=[
            SYSTEM_MSG, USER_MSG, ASSISTANT_MSG,
            make_tool_message(233, ml_tc1["id"], ml_tc1["name"], "synthetic result C"),
        ],
        tool_calls=[], finish_reason="stop",
        text="synthetic final answer",
    ),
])

# ─── 3. rollout-cross-batch-react.jsonl — 4 lines, 3 tool calls, 3+1 batch split ───
cb_session = f"sess_{deterministic_uuid(301)}"
cb_turn = f"turn_{deterministic_uuid(302)}"
cb_trace = deterministic_uuid(303)
cb_tc0 = make_tool_call(311, "Bash", "synthetic cross-batch A")
cb_tc1 = make_tool_call(312, "Bash", "synthetic cross-batch B")
cb_tc2 = make_tool_call(313, "Read", "synthetic cross-batch C")
write_fixture("rollout-cross-batch-react.jsonl", [
    make_line(
        session_id=cb_session, turn_id=cb_turn, trace_id=cb_trace,
        request_id=deterministic_uuid(321), seq=0,
        started_at="2026-07-13T05:00:00.000Z", completed_at="2026-07-13T05:00:04.000Z",
        input_messages=[SYSTEM_MSG, USER_MSG],
        tool_calls=[cb_tc0], finish_reason="tool-calls",
        text="synthetic cb step 0",
    ),
    make_line(
        session_id=cb_session, turn_id=cb_turn, trace_id=cb_trace,
        request_id=deterministic_uuid(322), seq=1,
        started_at="2026-07-13T05:00:06.000Z", completed_at="2026-07-13T05:00:09.000Z",
        input_messages=[
            SYSTEM_MSG, USER_MSG, ASSISTANT_MSG,
            make_tool_message(331, cb_tc0["id"], cb_tc0["name"], "synthetic cb result 0"),
        ],
        tool_calls=[cb_tc1], finish_reason="tool-calls",
        text="synthetic cb step 1",
    ),
    make_line(
        session_id=cb_session, turn_id=cb_turn, trace_id=cb_trace,
        request_id=deterministic_uuid(323), seq=2,
        started_at="2026-07-13T05:00:11.000Z", completed_at="2026-07-13T05:00:14.000Z",
        input_messages=[
            SYSTEM_MSG, USER_MSG, ASSISTANT_MSG,
            make_tool_message(332, cb_tc1["id"], cb_tc1["name"], "synthetic cb result 1"),
        ],
        tool_calls=[cb_tc2], finish_reason="tool-calls",
        text="synthetic cb step 2",
    ),
    make_line(
        session_id=cb_session, turn_id=cb_turn, trace_id=cb_trace,
        request_id=deterministic_uuid(324), seq=3,
        started_at="2026-07-13T05:00:16.000Z", completed_at="2026-07-13T05:00:18.000Z",
        input_messages=[
            SYSTEM_MSG, USER_MSG, ASSISTANT_MSG,
            make_tool_message(333, cb_tc2["id"], cb_tc2["name"], "synthetic cb result 2"),
        ],
        tool_calls=[], finish_reason="stop",
        text="synthetic cb final answer",
    ),
])

# ─── 4. rollout-iter4-2line-parallel.jsonl — 2 lines: 3 parallel toolCalls → stop ───
i4_session = f"sess_{deterministic_uuid(401)}"
i4_turn = f"turn_{deterministic_uuid(402)}"
i4_trace = deterministic_uuid(403)
i4_tc0 = make_tool_call(411, "Bash", "synthetic parallel A")
i4_tc1 = make_tool_call(412, "Bash", "synthetic parallel B")
i4_tc2 = make_tool_call(413, "Grep", "synthetic parallel C")
write_fixture("rollout-iter4-2line-parallel.jsonl", [
    make_line(
        session_id=i4_session, turn_id=i4_turn, trace_id=i4_trace,
        request_id=deterministic_uuid(421), seq=0,
        started_at="2026-07-13T06:00:00.000Z", completed_at="2026-07-13T06:00:05.000Z",
        input_messages=[SYSTEM_MSG, USER_MSG],
        tool_calls=[i4_tc0, i4_tc1, i4_tc2], finish_reason="tool-calls",
        text="synthetic iter4 step 0",
    ),
    make_line(
        session_id=i4_session, turn_id=i4_turn, trace_id=i4_trace,
        request_id=deterministic_uuid(422), seq=1,
        started_at="2026-07-13T06:00:08.000Z", completed_at="2026-07-13T06:00:12.000Z",
        input_messages=[
            SYSTEM_MSG, USER_MSG, ASSISTANT_MSG,
            make_tool_message(431, i4_tc0["id"], i4_tc0["name"], "synthetic parallel result A"),
            make_tool_message(432, i4_tc1["id"], i4_tc1["name"], "synthetic parallel result B"),
            make_tool_message(433, i4_tc2["id"], i4_tc2["name"], "synthetic parallel result C"),
        ],
        tool_calls=[], finish_reason="stop",
        text="synthetic iter4 final answer",
    ),
])

print("done")
