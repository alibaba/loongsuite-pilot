"""Run with PYTHONPATH=assets/plugins/strands-harness and strands-agents installed."""

import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from strands import Agent, tool
from strands.models.model import Model

import loongsuite_pilot_strands as pilot


@tool
def echo_value(value: str) -> str:
    """Echo the supplied test value."""
    return value


class FixtureModel(Model):
    def __init__(self, call_tool=False):
        self.calls = 0
        self.call_tool = call_tool

    def get_config(self):
        return {"model_id": "fixture-model"}

    def update_config(self, **kwargs):
        pass

    async def structured_output(self, *args, **kwargs):
        raise AssertionError("The test model expects the ordinary model stream")

    async def stream(self, *args, **kwargs):
        self.calls += 1
        yield {"messageStart": {"role": "assistant"}}
        if self.call_tool and self.calls == 1:
            yield {"contentBlockStart": {"start": {"toolUse": {"name": "echo_value", "toolUseId": "tool-1"}}}}
            yield {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"value":"fixture"}'}}}}
            stop = "tool_use"
        else:
            yield {"contentBlockStart": {"start": {}}}
            yield {"contentBlockDelta": {"delta": {"text": "fixture-result"}}}
            stop = "end_turn"
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": stop}}
        yield {"metadata": {"usage": {
            "inputTokens": self.calls * 10, "outputTokens": 3, "totalTokens": self.calls * 10 + 3,
        }, "metrics": {"latencyMs": 0}}}


class StrandsPluginTest(unittest.TestCase):
    def invoke(self, directory, *, content=True, call_tool=False):
        model = FixtureModel(call_tool=call_tool)
        plugin = pilot.PilotStrandsPlugin(
            session_id="test", provider="openai", data_dir=directory, capture_content=content,
        )
        agent = Agent(model=model, tools=[echo_value], plugins=[plugin], callback_handler=None)
        result = agent("fixture-prompt@example.net")
        self.assertEqual(str(result).strip(), "fixture-result")
        return model

    def published(self, directory):
        paths = list((Path(directory) / "logs/strands-harness").glob("*.jsonl"))
        self.assertEqual(len(paths), 1)
        return [json.loads(line) for line in paths[0].read_text().splitlines()]

    def test_model_rounds_and_native_tool_call_id(self):
        with tempfile.TemporaryDirectory() as directory:
            model = self.invoke(directory, call_tool=True)
            rows = self.published(directory)
        self.assertEqual(model.calls, 2)
        self.assertEqual(rows[0]["gen_ai.turn.start"], True)
        self.assertEqual(rows[-1]["gen_ai.turn.end"], True)
        responses = [row for row in rows if row["event.name"] == "llm.response"]
        self.assertEqual([row["gen_ai.usage.total_tokens"] for row in responses], [13, 23])
        tools = [row for row in rows if row["event.name"].startswith("tool.")]
        self.assertEqual([row["gen_ai.tool.call.id"] for row in tools], ["tool-1", "tool-1"])
        self.assertEqual(tools[0]["gen_ai.tool.call.arguments"], {"value": "fixture"})
        self.assertEqual(tools[1]["tool.result.status"], "success")
        self.assertEqual(tools[0]["gen_ai.step.id"], responses[0]["gen_ai.step.id"])

    def test_content_off_omits_source_content(self):
        with tempfile.TemporaryDirectory() as directory:
            self.invoke(directory, content=False, call_tool=True)
            rows = self.published(directory)
        content = {
            "gen_ai.input.messages", "gen_ai.input.messages_delta", "gen_ai.output.messages",
            "gen_ai.system_instructions", "gen_ai.tool.call.arguments", "gen_ai.tool.call.result",
        }
        self.assertFalse(any(content.intersection(row) for row in rows))
        self.assertEqual(len([r for r in rows if "gen_ai.usage.total_tokens" in r]), 2)

    def test_blocked_write_keeps_agent_result_and_has_a_bounded_wait(self):
        gate = threading.Event()
        started_write = threading.Event()

        def block_write(*args):
            started_write.set()
            return gate.wait(3)

        with tempfile.TemporaryDirectory() as directory, patch.object(pilot, "_write_segment", block_write):
            try:
                start = time.monotonic()
                model = self.invoke(directory)
                self.assertTrue(started_write.is_set())
                self.assertEqual(model.calls, 1)
                self.assertLess(time.monotonic() - start, 1.5)
            finally:
                gate.set()
                pilot._JOBS.join()

    def test_failed_write_preserves_agent_result(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "logs").write_text("not a directory")
            self.assertEqual(self.invoke(directory).calls, 1)


if __name__ == "__main__":
    unittest.main()
