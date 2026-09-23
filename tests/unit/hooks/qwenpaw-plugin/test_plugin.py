"""Focused native-ABI tests. Run with QwenPaw 2.1.0 / AgentScope 2.0.4.post1.

The runtime E2E creates the representative native records; these tests isolate
stream ownership, concurrent scope and final-close regressions found there.
"""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
from types import SimpleNamespace as NS
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
SPEC = importlib.util.spec_from_file_location("pilot_qwenpaw", ROOT / "assets/plugins/qwenpaw/loongsuite-pilot/plugin.py")
plugin = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = plugin
SPEC.loader.exec_module(plugin)

from agentscope.message import Msg, TextBlock, ThinkingBlock, ToolCallBlock, ToolResultBlock
from agentscope.formatter import DashScopeChatFormatter, OpenAIChatFormatter
from agentscope.model import ChatResponse, ChatUsage
from agentscope.tool import ToolResponse, ToolChunk
from agentscope.event import ToolCallStartEvent, TextBlockDeltaEvent


class Capture:
    def __init__(self):
        self.records = []
    def write(self, value):
        self.records.append(value)


class StreamTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.capture = Capture()
        self.old_writer = plugin._writer
        plugin._writer = self.capture
        self.token = plugin._scope.set(None)
        self.agent = NS(name="test", _system_prompt="system", model=NS(model="model"), toolkit=NS())
        self.scope = plugin.Scope({"gen_ai.session.id": "session", "gen_ai.turn.id": "turn"})
        self.middleware = plugin.PilotMiddleware(self.scope)

    def tearDown(self):
        plugin._writer = self.old_writer
        plugin._scope.reset(self.token)

    async def test_setup_messages_failure_calls_business_once_and_next_request_recovers(self):
        result = object()
        calls = 0
        async def handler(**kwargs):
            nonlocal calls
            calls += 1
            return result
        with patch.object(plugin, "_messages", side_effect=RuntimeError("telemetry")):
            self.assertIs(await self.middleware.on_model_call(self.agent, {}, handler), result)
        self.assertEqual(calls, 1)
        self.assertIsNone(plugin._scope.get())
        response = ChatResponse([TextBlock(text="healthy")], True)
        async def healthy(**kwargs):
            return response
        self.assertIs(await self.middleware.on_model_call(self.agent, {}, healthy), response)
        self.assertEqual(self.capture.records[-1]["event.name"], "llm.response")

    async def test_stream_observation_failure_preserves_all_chunk_objects(self):
        chunks = [ChatResponse([TextBlock(text="a")], False), ChatResponse([TextBlock(text="b")], True)]
        calls = 0
        async def source():
            for chunk in chunks:
                yield chunk
        async def handler(**kwargs):
            nonlocal calls
            calls += 1
            return source()
        stream = await self.middleware.on_model_call(self.agent, {}, handler)
        with patch.object(plugin, "_parts", side_effect=RuntimeError("telemetry")):
            received = [chunk async for chunk in stream]
        self.assertEqual(calls, 1)
        self.assertEqual(len(received), 2)
        self.assertTrue(all(a is b for a, b in zip(chunks, received)))
        self.assertIsNone(plugin._scope.get())

    async def test_finalizer_failure_preserves_business_error_and_success_object(self):
        error = ValueError("original")
        calls = 0
        async def failing(**kwargs):
            nonlocal calls
            calls += 1
            raise error
        with patch.object(self.middleware, "_model_end", side_effect=RuntimeError("telemetry")):
            with self.assertRaises(ValueError) as caught:
                await self.middleware.on_model_call(self.agent, {}, failing)
            self.assertIs(caught.exception, error)
            response = object()
            async def successful(**kwargs):
                nonlocal calls
                calls += 1
                return response
            self.assertIs(await self.middleware.on_model_call(self.agent, {}, successful), response)
        self.assertEqual(calls, 2)
        self.assertIsNone(plugin._scope.get())

    async def test_reply_setup_and_tool_finalizer_fail_open(self):
        item = object()
        calls = 0
        async def handler(**kwargs):
            nonlocal calls
            calls += 1
            yield item
        with patch.object(plugin, "_messages", side_effect=RuntimeError("telemetry")):
            self.assertEqual([x async for x in self.middleware.on_reply(self.agent, {}, handler)], [item])
        with patch.object(self.middleware, "_tool_end", side_effect=RuntimeError("telemetry")):
            self.assertEqual([x async for x in self.middleware.on_acting(self.agent, {}, handler)], [item])
        self.assertEqual(calls, 2)
        self.assertIsNone(plugin._scope.get())

    async def test_stream_finalizer_failure_preserves_original_error(self):
        error = ValueError("native stream")
        item = object()
        async def source():
            yield item
            raise error
        async def handler(**kwargs):
            return source()
        stream = await self.middleware.on_model_call(self.agent, {}, handler)
        with patch.object(self.middleware, "_model_end", side_effect=RuntimeError("telemetry")):
            self.assertIs(await anext(stream), item)
            with self.assertRaises(ValueError) as caught:
                await anext(stream)
            self.assertIs(caught.exception, error)
        self.assertIsNone(plugin._scope.get())

    async def test_nonstream_has_usage_but_no_fake_ttft(self):
        response = ChatResponse([TextBlock(text="done")], True, usage=ChatUsage(12, 4, 1.0, cache_input_tokens=7))
        async def handler(**kwargs):
            return response
        actual = await self.middleware.on_model_call(self.agent, {"messages": [Msg(name="u", content=[TextBlock(text="hi")], role="user")]}, handler)
        self.assertIs(response, actual)
        request, result = self.capture.records
        self.assertEqual(request["gen_ai.step.id"], result["gen_ai.step.id"])
        self.assertEqual(result["gen_ai.usage.cache_read.input_tokens"], 7)
        self.assertNotIn("gen_ai.response.time_to_first_token", result)

    async def test_llm_input_respects_native_formatter_without_mutating_messages(self):
        messages = [Msg(name="assistant", role="assistant", content=[ThinkingBlock(thinking="reasoning"), TextBlock(text="visible")])]
        response = ChatResponse([ThinkingBlock(thinking="new reasoning"), TextBlock(text="answer")], True)
        async def handler(**kwargs):
            self.assertIs(kwargs["messages"], messages)
            self.assertIsInstance(messages[0].content[0], ThinkingBlock)
            return response
        cases = [(DashScopeChatFormatter(), False),
                 (DashScopeChatFormatter(input_types=["text/plain", "application/x-thinking"]), True),
                 (OpenAIChatFormatter(), True), (None, True)]
        for formatter, include_reasoning in cases:
            with self.subTest(formatter=type(formatter).__name__, include_reasoning=include_reasoning):
                self.capture.records.clear()
                model = NS(model="qwen", formatter=formatter)
                self.assertIs(await self.middleware.on_model_call(self.agent, {"current_model": model, "messages": messages}, handler), response)
                request, result = self.capture.records
                parts = request["gen_ai.input.messages"][0]["parts"]
                self.assertEqual([p["type"] for p in parts], ["reasoning", "text"] if include_reasoning else ["text"])
                self.assertEqual(result["gen_ai.output.messages"][0]["parts"][0]["type"], "reasoning")

    async def test_cancel_preserves_entry_deltas_without_inventing_agent_output(self):
        plugin._boundary(self.scope, "turn")
        async def reply(**kwargs):
            yield TextBlockDeltaEvent(reply_id="r", block_id="b", delta="par")
            yield TextBlockDeltaEvent(reply_id="r", block_id="b", delta="tial")
        stream = self.middleware.on_reply(self.agent, {}, reply)
        await anext(stream)
        await anext(stream)
        plugin._finish_request(self.scope, asyncio.CancelledError("stop"))
        await stream.aclose()
        entry = next(r for r in self.capture.records if r.get("agent.qwenpaw.boundary") == "entry.end")
        agent = next(r for r in self.capture.records if r.get("agent.qwenpaw.boundary") == "agent.end")
        self.assertEqual(entry["gen_ai.output.messages"][0]["parts"], [{"type": "text", "content": "partial"}])
        self.assertEqual(entry["response.finish_reasons"], "interrupted")
        self.assertEqual(agent["gen_ai.output.messages"], [])

    async def test_complete_reply_replaces_partial_and_tool_boundary_resets_text(self):
        async def reply(**kwargs):
            yield TextBlockDeltaEvent(reply_id="r", block_id="b", delta="before tool")
            yield ToolCallStartEvent(reply_id="r", tool_call_id="t", tool_call_name="read_file")
            yield TextBlockDeltaEvent(reply_id="r", block_id="c", delta="after")
            self.assertEqual(self.scope.output[0]["parts"][0]["content"], "after")
            yield Msg(name="test", role="assistant", content=[TextBlock(text="final")])
        async for _ in self.middleware.on_reply(self.agent, {}, reply):
            pass
        self.assertEqual(self.scope.output[0]["parts"][0]["content"], "final")

    async def test_nested_helper_partial_does_not_replace_entry_output(self):
        self.scope.output = [{"role": "assistant", "parts": [{"type": "text", "content": "visible"}]}]
        tool = plugin.Scope({}, parent=self.scope)
        token = plugin._scope.set(tool)
        async def reply(**kwargs):
            yield TextBlockDeltaEvent(reply_id="helper", block_id="b", delta="hidden helper")
        stream = self.middleware.on_reply(self.agent, {}, reply)
        try:
            await anext(stream)
            await stream.aclose()
        finally:
            plugin._scope.reset(token)
        self.assertEqual(self.scope.output[0]["parts"][0]["content"], "visible")

    async def test_completed_tool_generator_close_is_success(self):
        response = ToolResponse(content=[TextBlock(text="value")])
        closed = []
        async def handler(**kwargs):
            try:
                yield response
            finally:
                closed.append(True)
        stream = self.middleware.on_acting(self.agent, {"tool_call": ToolCallBlock(id="call", name="read_file", input="{}")}, handler)
        self.assertIs(await anext(stream), response)
        await stream.aclose()
        result = self.capture.records[-1]
        self.assertEqual(result["tool.result.status"], "success")
        self.assertNotIn("error.type", result)
        self.assertEqual(closed, [True])
        self.assertIsNone(plugin._scope.get())

    async def test_partial_model_close_records_cancel_and_keeps_original_chunk(self):
        chunk = ChatResponse([TextBlock(text="partial")], False)
        closed = []
        async def source():
            try:
                yield chunk
                yield ChatResponse([TextBlock(text="done")], True)
            finally:
                closed.append(True)
        async def handler(**kwargs):
            return source()
        stream = await self.middleware.on_model_call(self.agent, {}, handler)
        self.assertIs(await anext(stream), chunk)
        self.assertIsNone(plugin._scope.get())
        await stream.aclose()
        result = self.capture.records[-1]
        self.assertTrue(result["agent.qwenpaw.cancelled"])
        self.assertEqual(result["response.finish_reasons"], "interrupted")
        self.assertGreater(result["gen_ai.response.time_to_first_token"], 0)
        self.assertEqual(closed, [True])

    async def test_completed_model_close_is_not_cancelled(self):
        async def source():
            yield ChatResponse([TextBlock(text="done")], True)
        async def handler(**kwargs):
            return source()
        stream = await self.middleware.on_model_call(self.agent, {}, handler)
        await anext(stream)
        await stream.aclose()
        self.assertNotIn("error.type", self.capture.records[-1])

    async def test_concurrent_requests_keep_their_scopes(self):
        gate = asyncio.Event()
        entered = []
        async def run(name):
            scope = plugin.Scope({"gen_ai.session.id": name, "gen_ai.turn.id": name})
            mw = plugin.PilotMiddleware(scope)
            agent = NS(name=name, _system_prompt="", state=NS(session_id=name))
            async def handler(**kwargs):
                self.assertEqual(plugin._scope.get().fields["gen_ai.session.id"], name)
                entered.append(name)
                if len(entered) == 2:
                    gate.set()
                await gate.wait()
                self.assertEqual(plugin._scope.get().fields["gen_ai.session.id"], name)
                yield Msg(name=name, content=[TextBlock(text=name)], role="assistant")
            async for _ in mw.on_reply(agent, {}, handler):
                self.assertIsNone(plugin._scope.get())
        await asyncio.gather(run("first"), run("second"))
        ends = [r for r in self.capture.records if r.get("agent.qwenpaw.boundary") == "agent.end"]
        self.assertEqual(len(ends), 2)
        for row in ends:
            self.assertEqual(row["gen_ai.output.messages"][0]["parts"][0]["content"], row["gen_ai.session.id"])
            self.assertNotIn("gen_ai.agent.id", row)
            self.assertTrue(row["agent.qwenpaw.agent.id"])

    async def test_provider_error_propagates_and_is_recorded_once(self):
        failure = RuntimeError("provider failure")
        async def handler(**kwargs):
            raise failure
        with self.assertRaises(RuntimeError) as caught:
            await self.middleware.on_model_call(self.agent, {}, handler)
        self.assertIs(caught.exception, failure)
        self.assertEqual([r["event.name"] for r in self.capture.records], ["llm.request", "llm.response"])
        self.assertEqual(self.capture.records[-1]["error.type"], "RuntimeError")

    async def test_raw_tool_error_is_not_success(self):
        async def handler(**kwargs):
            yield ToolResponse(content=[TextBlock(text="missing")], state="error")
        async for _ in self.middleware.on_acting(self.agent, {"tool_call": ToolCallBlock(id="call", name="read_file", input="{}")}, handler):
            pass
        self.assertEqual(self.capture.records[-1]["error.type"], "ToolError")

    async def test_terminal_tool_chunk_error_survives_native_close(self):
        async def handler(**kwargs):
            yield ToolChunk(content=[TextBlock(text="missing file")], state="error")
        stream = self.middleware.on_acting(self.agent, {"tool_call": ToolCallBlock(id="bad", name="read_file", input="{}")}, handler)
        await anext(stream)
        await stream.aclose()
        result = self.capture.records[-1]
        self.assertEqual(result["error.type"], "ToolError")
        self.assertNotIn("agent.qwenpaw.cancelled", result)
        self.assertEqual(result["gen_ai.tool.call.result"][0], {"type": "text", "content": "missing file"})

    async def test_request_cancel_closes_children_before_terminal_once(self):
        plugin._boundary(self.scope, "turn")
        async def model(**kwargs):
            async def chunks():
                yield ChatResponse([TextBlock(text="partial")], False)
                yield ChatResponse([TextBlock(text="done")], True)
            return chunks()
        async def reply(**kwargs):
            stream = await self.middleware.on_model_call(self.agent, {}, model)
            try:
                async for chunk in stream:
                    yield chunk
            finally:
                await stream.aclose()
        stream = self.middleware.on_reply(self.agent, {}, reply)
        await anext(stream)
        plugin._finish_request(self.scope, asyncio.CancelledError())
        records_at_end = len(self.capture.records)
        self.assertEqual(self.capture.records[-1]["agent.qwenpaw.boundary"], "entry.end")
        await stream.aclose()
        self.assertEqual(len(self.capture.records), records_at_end)
        self.assertEqual(len([r for r in self.capture.records if r["event.name"] == "llm.response"]), 1)
        self.assertTrue(all(c.ended for c in self.scope.children))


    async def test_react_step_contains_acting_until_next_reasoning_and_reply_end(self):
        tool_event = ToolCallStartEvent(reply_id="r", tool_call_id="tool", tool_call_name="read_file")
        text_event = TextBlockDeltaEvent(reply_id="r", block_id="text", delta="done")
        async def first_reasoning(**kwargs):
            yield tool_event
        async def final_reasoning(**kwargs):
            yield text_event
            self.assertIsNotNone(self.scope.first)  # Observed native delta, before final Msg.
            yield Msg(name="test", content=[TextBlock(text="done")], role="assistant")
        async def acting(**kwargs):
            yield ToolResponse(content=[TextBlock(text="file")])
        async def reply(**kwargs):
            async for item in self.middleware.on_reasoning(self.agent, {}, first_reasoning):
                yield item
            self.assertFalse(any(r.get("agent.qwenpaw.boundary") == "step.end" for r in self.capture.records))
            tool = ToolCallBlock(id="tool", name="read_file", input="{}")
            async for item in self.middleware.on_acting(self.agent, {"tool_call": tool}, acting):
                yield item
            self.assertFalse(any(r.get("agent.qwenpaw.boundary") == "step.end" for r in self.capture.records))
            async for item in self.middleware.on_reasoning(self.agent, {}, final_reasoning):
                yield item
        async for _ in self.middleware.on_reply(self.agent, {}, reply):
            pass
        steps = [r for r in self.capture.records if r.get("agent.qwenpaw.boundary") == "step.end"]
        self.assertEqual(len(steps), 2)
        self.assertEqual(steps[0]["response.finish_reasons"], "tool_calls")
        self.assertEqual(steps[1]["response.finish_reasons"], "stop")
        tool_start, tool_end = [r for r in self.capture.records if r["event.name"] in ("tool.call", "tool.result")]
        self.assertEqual(tool_start["agent.qwenpaw.parent.id"], steps[0]["agent.qwenpaw.span.id"])
        self.assertLessEqual(int(tool_end["time_unix_nano"]), int(steps[0]["time_unix_nano"]))
        starts = [r for r in self.capture.records if r.get("agent.qwenpaw.boundary") == "step.start"]
        self.assertLessEqual(int(steps[0]["time_unix_nano"]), int(starts[1]["time_unix_nano"]))
        self.assertIsNotNone(self.scope.first)
        self.assertEqual(self.scope.fields["gen_ai.agent.name"], "test")
        self.assertTrue(all(c.ended for c in self.scope.children))

    async def test_cancel_during_acting_closes_tool_step_agent_before_entry(self):
        plugin._boundary(self.scope, "turn")
        async def reasoning(**kwargs):
            yield ToolCallStartEvent(reply_id="r", tool_call_id="tool", tool_call_name="read_file")
        async def acting(**kwargs):
            yield ToolChunk(content=[TextBlock(text="partial")])
            yield ToolResponse(content=[TextBlock(text="complete")])
        async def reply(**kwargs):
            async for item in self.middleware.on_reasoning(self.agent, {}, reasoning):
                yield item
            tool = ToolCallBlock(id="tool", name="read_file", input="{}")
            stream = self.middleware.on_acting(self.agent, {"tool_call": tool}, acting)
            try:
                async for item in stream:
                    yield item
            finally:
                await stream.aclose()
        stream = self.middleware.on_reply(self.agent, {}, reply)
        await anext(stream)
        await anext(stream)
        plugin._finish_request(self.scope, asyncio.CancelledError())
        closed_records = list(self.capture.records)
        await stream.aclose()
        self.assertEqual(self.capture.records, closed_records)
        ends = [r for r in closed_records if r["event.name"] == "tool.result" or str(r.get("agent.qwenpaw.boundary", "")).endswith(".end")]
        self.assertEqual([r.get("agent.qwenpaw.boundary", r["event.name"]) for r in ends], ["tool.result", "step.end", "agent.end", "entry.end"])
        self.assertTrue(all(r["error.type"] == "CancelledError" for r in ends))
        self.assertTrue(all(c.ended for c in self.scope.children))

    async def test_native_constructor_attachment_is_once_and_reversible(self):
        from agentscope.agent import Agent
        owner = plugin.PilotPlugin()
        original = Agent.__init__
        try:
            owner._attach_helpers()
            existing = plugin.PilotMiddleware()
            explicit = Agent("explicit", "system", NS(), None, [existing])
            helper = Agent("helper", "system", NS())
            self.assertEqual(explicit._reply_middlewares, [existing])
            self.assertEqual(len(helper._reply_middlewares), 1)
            self.assertIsInstance(helper._reply_middlewares[0], plugin.PilotMiddleware)
        finally:
            await owner.shutdown()
        self.assertIs(Agent.__init__, original)


    async def test_existing_helper_middleware_bypasses_all_hooks_after_shutdown(self):
        from agentscope.agent import Agent
        owner = plugin.PilotPlugin()
        owner._attach_helpers()
        agent = Agent("existing", "system", NS())
        middleware = agent._reply_middlewares[0]
        await owner.shutdown()
        value = Msg(name="existing", content=[TextBlock(text="business continues")], role="assistant")
        async def stream(**kwargs):
            yield value
        async def model(**kwargs):
            return value
        for hook in (middleware.on_reply, middleware.on_reasoning, middleware.on_acting):
            self.assertEqual([item async for item in hook(agent, {}, stream)], [value])
        self.assertIs(await middleware.on_model_call(agent, {}, model), value)
        self.assertEqual(self.capture.records, [])

    async def test_shutdown_suppresses_events_from_an_already_suspended_reply(self):
        owner = plugin.PilotPlugin()
        middleware = plugin.PilotMiddleware(owner=owner)
        async def reply(**kwargs):
            yield Msg(name="a", content=[TextBlock(text="first")], role="assistant")
            yield Msg(name="a", content=[TextBlock(text="last")], role="assistant")
        stream = middleware.on_reply(self.agent, {}, reply)
        await anext(stream)
        before_shutdown = len(self.capture.records)
        self.assertGreater(before_shutdown, 0)
        await owner.shutdown()
        await anext(stream)
        await stream.aclose()
        self.assertEqual(len(self.capture.records), before_shutdown)

    async def test_shutdown_suppresses_suspended_tool_without_request_parent(self):
        owner = plugin.PilotPlugin()
        middleware = plugin.PilotMiddleware(owner=owner)
        async def handler(**kwargs):
            yield ToolResponse(content=[TextBlock(text="result")])
        tool = ToolCallBlock(id="direct", name="read_file", input="{}")
        stream = middleware.on_acting(self.agent, {"tool_call": tool}, handler)
        await anext(stream)
        self.assertEqual(len(self.capture.records), 1)
        await owner.shutdown()
        await stream.aclose()
        self.assertEqual(len(self.capture.records), 1)

    async def test_skill_tool_records_native_frontmatter_and_cached_description(self):
        from agentscope.skill import Skill
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root) / "workspaces" / "worker" / "skills" / "witness"
            directory.mkdir(parents=True)
            (directory / "SKILL.md").write_text("---\nname: witness\ndescription: From frontmatter\nmetadata:\n  version: 1.2.3\n---\nBody")
            skill = Skill("witness", "Cached description", str(directory), "Body", 0)
            self.agent.toolkit = NS(_qp_skills={"witness": {"dir": str(directory)}},
                tool_groups=[NS(skills_or_loaders=[NS(_cache={"witness": skill})])])
            async def handler(**kwargs):
                yield ToolResponse(content=[TextBlock(text="skill body")])
            tool_call = ToolCallBlock(id="skill-call", name="Skill", input='{"skill":"witness"}')
            async for _ in self.middleware.on_acting(self.agent, {"tool_call": tool_call}, handler):
                pass
            for record in self.capture.records:
                self.assertEqual(record["gen_ai.skill.name"], "witness")
                self.assertEqual(record["gen_ai.skill.id"], "workspace:worker:witness")
                self.assertEqual(record["gen_ai.skill.description"], "Cached description")
                self.assertEqual(record["gen_ai.skill.version"], "1.2.3")


class RegistrationTests(unittest.IsolatedAsyncioTestCase):
    def api(self):
        return NS(hooks=[], factories=[], cleanups=[],
                  register_runtime_hook=lambda hook: self.api_state.hooks.append(hook),
                  register_middleware=lambda factory, **kwargs: self.api_state.factories.append(factory),
                  register_shutdown_hook=lambda name, fn: self.api_state.cleanups.append(fn),
                  register_uninstall_hook=lambda name, fn: self.api_state.cleanups.append(fn))

    async def asyncSetUp(self):
        self.api_state = self.api()
        self.owner = plugin.PilotPlugin()
        self.writer_patch = patch.object(plugin, "_writer", Capture())
        self.writer_patch.start()

    async def asyncTearDown(self):
        await self.owner.shutdown()
        self.writer_patch.stop()

    async def test_registration_ignores_package_version_and_preserves_standard_identity(self):
        with patch("importlib.metadata.version", side_effect=RuntimeError("metadata unavailable")):
            self.owner.register(self.api_state)
        self.assertEqual(len(self.api_state.hooks), 3)
        capture = Capture()
        ctx = NS(request=NS(id="request", user_id="user", input=[], request_context={"agentcore": {"runId": "private"}}),
                 session_id="conversation", agent_id="agent", extras={}, error=None)
        with patch.object(plugin, "_writer", capture):
            await self.api_state.hooks[0].run(ctx)
            self.assertIsNone(plugin._scope.get())
            await self.api_state.hooks[1].run(ctx)
            self.assertIsNone(plugin._scope.get())
        self.assertEqual(len(capture.records), 2)
        for record in capture.records:
            self.assertEqual(record["gen_ai.session.id"], "conversation")
            self.assertEqual(record["gen_ai.turn.id"], "request")
            self.assertEqual(record["user.id"], "user")
            self.assertFalse(any(key.startswith("agentcore.") for key in record))

    async def test_request_mapping_failure_preserves_identity_and_entry_lifecycle(self):
        self.owner.register(self.api_state)
        start, finish, complete = self.api_state.hooks
        for completed in (True, False):
            with self.subTest(completed=completed):
                capture = Capture()
                ctx = NS(request=NS(id="native-request", user_id="native-user", input=["unmappable"]),
                         session_id="native-session", agent_id="native-agent", extras={}, error=None)
                with patch.object(plugin, "_writer", capture):
                    with patch.object(plugin, "_messages", side_effect=ValueError("private message")):
                        await start.run(ctx)
                    request_scope = ctx.extras[plugin._CTX_KEY][0]
                    middleware = self.api_state.factories[0](ctx, None)
                    self.assertIs(middleware.request_scope, request_scope)
                    result = Msg(name="assistant", role="assistant", content=[TextBlock(text="business OK")])
                    calls = 0
                    async def business(**kwargs):
                        nonlocal calls
                        calls += 1
                        yield result
                    agent = NS(name="agent", model=NS(), state=NS())
                    received = [item async for item in middleware.on_reply(agent, {}, business)]
                    self.assertEqual(calls, 1)
                    self.assertIs(received[0], result)
                    if completed:
                        await complete.run(ctx)
                    else:
                        ctx.error = asyncio.CancelledError()
                    await finish.run(ctx)
                entries = [row for row in capture.records if row.get("agent.qwenpaw.boundary", "").startswith("entry.")]
                self.assertEqual([row["agent.qwenpaw.boundary"] for row in entries], ["entry.start", "entry.end"])
                self.assertNotIn("gen_ai.input.messages", entries[0])
                self.assertEqual(entries[0]["agent.qwenpaw.span.id"], entries[1]["agent.qwenpaw.span.id"])
                for row in capture.records:
                    self.assertEqual(row["gen_ai.session.id"], "native-session")
                    self.assertEqual(row["gen_ai.turn.id"], "native-request")
                    self.assertEqual(row["user.id"], "native-user")
                agent_start = next(row for row in capture.records if row.get("agent.qwenpaw.boundary") == "agent.start")
                self.assertEqual(agent_start["agent.qwenpaw.parent.id"], entries[0]["agent.qwenpaw.span.id"])
                self.assertEqual(ctx.extras, {})
                self.assertIsNone(plugin._scope.get())
                if not completed:
                    self.assertEqual(entries[1]["error.type"], "CancelledError")
        self.assertIn("runtime request messages", self.owner.diagnostics)

    async def test_post_response_closes_before_terminal_and_finally_is_idempotent(self):
        self.owner.register(self.api_state)
        ctx = NS(request=NS(id="complete", user_id="u", input=[]), session_id="session", agent_id="a", extras={}, error=None)
        start, finish, complete = self.api_state.hooks
        self.assertGreater(complete.priority, 95)
        await start.run(ctx)
        await complete.run(ctx)
        records = plugin._writer.records
        self.assertEqual(records[-1]["agent.qwenpaw.boundary"], "entry.end")
        self.assertEqual(len(records), 2)
        self.assertIsNone(plugin._scope.get())
        # The native terminal yield happens here, before FINALLY.
        await finish.run(ctx)
        self.assertEqual(len(records), 2)
        self.assertEqual(ctx.extras, {})

    async def test_finally_preserves_error_when_post_response_is_not_reached(self):
        self.owner.register(self.api_state)
        ctx = NS(request=NS(id="failed", input=[]), session_id="session", agent_id="a", extras={}, error=asyncio.CancelledError())
        await self.api_state.hooks[0].run(ctx)
        await self.api_state.hooks[1].run(ctx)
        self.assertEqual(plugin._writer.records[-1]["error.type"], "CancelledError")
        self.assertTrue(plugin._writer.records[-1]["agent.qwenpaw.cancelled"])

    async def test_late_runtime_failure_is_diagnosed_without_duplicate_entry(self):
        self.owner.register(self.api_state)
        ctx = NS(request=NS(id="late", input=[]), session_id="session", agent_id="a", extras={}, error=None)
        await self.api_state.hooks[0].run(ctx)
        await self.api_state.hooks[2].run(ctx)
        error = ValueError("later host hook")
        ctx.error = error
        await self.api_state.hooks[1].run(ctx)
        self.assertIs(ctx.error, error)
        self.assertEqual(len(plugin._writer.records), 2)
        self.assertIn("runtime failure after response completion", self.owner.diagnostics)

    async def test_complete_observer_failure_does_not_break_business_or_finally(self):
        self.owner.register(self.api_state)
        ctx = NS(request=NS(id="retry", input=[]), session_id="session", agent_id="a", extras={}, error=None)
        await self.api_state.hooks[0].run(ctx)
        with patch.object(plugin, "_finish_request", side_effect=RuntimeError("observer")):
            await self.api_state.hooks[2].run(ctx)
        await self.api_state.hooks[1].run(ctx)
        self.assertEqual(plugin._writer.records[-1]["agent.qwenpaw.boundary"], "entry.end")
        self.assertEqual(ctx.extras, {})

    async def test_suspended_reply_and_cross_task_finish_do_not_leak_context(self):
        self.owner.register(self.api_state)
        ctx = NS(request=NS(id="one", user_id="u", input=[]), session_id="session", agent_id="a", extras={}, error=None)
        await self.api_state.hooks[0].run(ctx)
        self.assertIsNone(plugin._scope.get())
        middleware = self.api_state.factories[0](ctx, None)
        first, last = object(), object()
        async def source(**kwargs):
            self.assertIsNotNone(plugin._scope.get())
            yield first
            self.assertIsNotNone(plugin._scope.get())
            yield last
        stream = middleware.on_reply(NS(name="agent", model=NS(), state=NS()), {}, source)
        self.assertIs(await asyncio.create_task(anext(stream)), first)
        self.assertIsNone(plugin._scope.get())
        self.assertIs(await asyncio.create_task(anext(stream)), last)
        self.assertIsNone(plugin._scope.get())
        await asyncio.create_task(self.api_state.hooks[1].run(ctx))
        await asyncio.create_task(stream.aclose())
        self.assertIsNone(plugin._scope.get())
        self.assertEqual(ctx.extras, {})
        # The same consumer can start another request without inheriting one.
        ctx.request.id = "two"
        await self.api_state.hooks[0].run(ctx)
        self.assertIsNone(plugin._scope.get())
        await self.api_state.hooks[1].run(ctx)
        self.assertIsNone(plugin._scope.get())

    async def test_missing_middleware_retains_runtime_hooks(self):
        with patch.object(plugin, "MiddlewareBase", object):
            self.owner.register(self.api_state)
        self.assertEqual(len(self.api_state.hooks), 3)
        self.assertEqual(self.api_state.factories, [])
        self.assertIn("AgentScope middleware", self.owner.diagnostics)

    async def test_missing_runtime_api_retains_middleware(self):
        self.api_state.register_runtime_hook = None
        self.owner.register(self.api_state)
        self.assertEqual(len(self.api_state.factories), 1)
        self.assertIn("runtime hooks", self.owner.diagnostics)

    async def test_optional_wrappers_fail_independently(self):
        with patch.object(self.owner, "_attach_helpers", side_effect=ImportError()), patch.object(self.owner, "_attach_dream", return_value=False):
            self.owner.register(self.api_state)
        self.assertTrue(self.owner.active)
        self.assertEqual(len(self.api_state.factories), 1)
        self.assertIn("helper agents", self.owner.diagnostics)
        self.assertIn("Dream", self.owner.diagnostics)

    async def test_registration_failure_disables_partial_hooks(self):
        def fail(*args, **kwargs):
            raise RuntimeError("registration failure")
        self.api_state.register_middleware = fail
        self.owner.register(self.api_state)
        self.assertFalse(self.owner.active)
        capture = Capture()
        with patch.object(plugin, "_writer", capture):
            await self.api_state.hooks[0].run(NS())
        self.assertEqual(capture.records, [])
        self.assertIn("plugin registration", self.owner.diagnostics)

    async def test_helper_without_middleware_argument_is_not_patched(self):
        from agentscope.agent import Agent
        def incompatible(self, name):
            pass
        with patch.object(Agent, "__init__", incompatible):
            self.assertFalse(self.owner._attach_helpers())
            self.assertIs(Agent.__init__, incompatible)

    async def test_dream_observer_faults_preserve_business_result_error_and_context(self):
        from qwenpaw.agents.memory.reme_light_memory_manager import ReMeLightMemoryManager
        result = object()
        business_error = ValueError("native Dream failure")
        calls = 0
        async def native(instance, fail=False):
            nonlocal calls
            calls += 1
            if fail:
                raise business_error
            return result
        with patch.object(ReMeLightMemoryManager, "dream", native, create=True):
            self.owner._attach_dream()
            dream = ReMeLightMemoryManager.dream
            with patch.object(plugin, "_boundary", side_effect=RuntimeError("setup")):
                self.assertIs(await dream(NS(agent_id="test")), result)
            self.assertIsNone(plugin._scope.get())
            with patch.object(plugin, "_finish_request", side_effect=RuntimeError("finalization")):
                self.assertIs(await dream(NS(agent_id="test")), result)
                self.assertIsNone(plugin._scope.get())
                with self.assertRaises(ValueError) as caught:
                    await dream(NS(agent_id="test"), fail=True)
                self.assertIs(caught.exception, business_error)
                self.assertIsNone(plugin._scope.get())
            self.assertEqual(calls, 3)
            await self.owner.shutdown()

    async def test_dream_owner_matches_loongsuite_name_fallback(self):
        from qwenpaw.agents.memory.reme_light_memory_manager import ReMeLightMemoryManager
        async def native(instance):
            return plugin._scope.get().fields.get("agent.qwenpaw.dream.owner")
        with patch.object(ReMeLightMemoryManager, "dream", native, create=True):
            self.owner._attach_dream()
            for name, expected in (("Owner", "Owner"), ("", "QwenPaw"),
                                   (None, "QwenPaw"), ("  ", None), (42, None)):
                with self.subTest(name=name), patch("qwenpaw.config.config.load_agent_config", return_value=NS(name=name)):
                    self.assertEqual(await ReMeLightMemoryManager.dream(NS(agent_id="workspace-id")), expected)
                    self.assertIsNone(plugin._scope.get())
            with patch("qwenpaw.config.config.load_agent_config", side_effect=RuntimeError("unavailable")):
                self.assertIsNone(await ReMeLightMemoryManager.dream(NS(agent_id="workspace-id")))
                self.assertIsNone(plugin._scope.get())
            await self.owner.shutdown()

    async def test_memory_action_only_wraps_dream_and_restores_original(self):
        calls = []
        result = NS(success=True)
        class Manager:
            agent_id = "owner"
            async def run_action(instance, action, **kwargs):
                calls.append((action, kwargs, plugin._scope.get()))
                return result
        original = Manager.run_action
        capture = Capture()
        with patch("qwenpaw.agents.memory.reme_light_memory_manager.ReMeLightMemoryManager", Manager), \
             patch("qwenpaw.config.config.load_agent_config", return_value=NS(name="Owner")), \
             patch.object(plugin, "_writer", capture):
            self.owner._attach_dream()
            wrapped = Manager.run_action
            manager = Manager()
            for action in ("auto_memory", "daily_paper", "reindex", "auto_fin"):
                self.assertIs(await manager.run_action(action, hint="keep"), result)
            self.assertEqual(capture.records, [])
            self.assertTrue(all(scope is None for _, _, scope in calls))
            self.assertIs(await manager.run_action("auto_dream", date="today"), result)
            self.assertIs(await manager.run_action(action="auto_dream", hint="keep"), result)
            self.assertEqual([row["agent.qwenpaw.boundary"] for row in capture.records],
                             ["entry.start", "entry.end", "entry.start", "entry.end"])
            self.assertEqual(calls[-2][1], {"date": "today"})
            self.assertEqual(calls[-1][2].fields["agent.qwenpaw.dream.owner"], "Owner")
            self.assertIsNone(plugin._scope.get())
            await self.owner.shutdown()
            self.assertIs(Manager.run_action, original)
            count = len(capture.records)
            self.assertIs(await wrapped(manager, "auto_dream"), result)
            self.assertEqual(len(capture.records), count)

    async def test_memory_action_error_cancel_and_false_result_preserve_business(self):
        failure = ValueError("native action failure")
        failed_result = NS(success=False, answer="private error detail")
        calls = []
        class Manager:
            agent_id = "owner"
            async def run_action(instance, action, mode=None):
                calls.append(mode)
                if mode == "error":
                    raise failure
                if mode == "cancel":
                    raise asyncio.CancelledError()
                if mode == "unavailable":
                    return None
                return failed_result
        capture = Capture()
        with patch("qwenpaw.agents.memory.reme_light_memory_manager.ReMeLightMemoryManager", Manager), \
             patch.object(plugin, "_writer", capture):
            self.owner._attach_dream()
            with self.assertRaises(ValueError) as caught:
                await Manager().run_action("auto_dream", mode="error")
            self.assertIs(caught.exception, failure)
            self.assertIsNone(plugin._scope.get())
            with self.assertRaises(asyncio.CancelledError):
                await Manager().run_action("auto_dream", mode="cancel")
            self.assertIsNone(plugin._scope.get())
            self.assertIs(await Manager().run_action("auto_dream"), failed_result)
            self.assertIsNone(await Manager().run_action("auto_dream", mode="unavailable"))
            self.assertEqual(calls, ["error", "cancel", None, "unavailable"])
            ends = [r for r in capture.records if r.get("agent.qwenpaw.boundary") == "entry.end"]
            self.assertEqual([r.get("error.type") for r in ends], ["ValueError", "CancelledError", "RuntimeError", "RuntimeError"])
            self.assertNotIn("private error detail", str(capture.records))
            self.assertIsNone(plugin._scope.get())

    async def test_memory_action_concurrent_owners_do_not_inherit_foreground(self):
        entered = []
        gate = asyncio.Event()
        class Manager:
            def __init__(instance, name):
                instance.agent_id = name
            async def run_action(instance, action):
                scope = plugin._scope.get()
                entered.append(scope)
                if len(entered) == 2:
                    gate.set()
                await gate.wait()
                self.assertIs(plugin._scope.get(), scope)
                self.assertEqual(scope.fields["agent.qwenpaw.dream.owner"], instance.agent_id)
                return NS(success=True)
        with patch("qwenpaw.agents.memory.reme_light_memory_manager.ReMeLightMemoryManager", Manager), \
             patch("qwenpaw.config.config.load_agent_config", side_effect=lambda name: NS(name=name)):
            self.owner._attach_dream()
            foreground = plugin.Scope({"gen_ai.session.id": "foreground"})
            token = plugin._scope.set(foreground)
            try:
                await asyncio.gather(Manager("first").run_action("auto_dream"), Manager("second").run_action("auto_dream"))
                self.assertIs(plugin._scope.get(), foreground)
                self.assertEqual({scope.fields["gen_ai.session.id"] for scope in entered}, {"dream:first", "dream:second"})
                self.assertTrue(all(scope.parent is None and scope.ended for scope in entered))
            finally:
                plugin._scope.reset(token)

    async def test_memory_action_observation_failure_does_not_change_result(self):
        result = NS(success=True)
        calls = []
        class Manager:
            agent_id = "owner"
            async def run_action(instance, action):
                calls.append(action)
                return result
        with patch("qwenpaw.agents.memory.reme_light_memory_manager.ReMeLightMemoryManager", Manager):
            self.owner._attach_dream()
            with patch.object(plugin, "_boundary", side_effect=RuntimeError("setup")):
                self.assertIs(await Manager().run_action("auto_dream"), result)
            with patch.object(plugin, "_finish_request", side_effect=RuntimeError("finish")):
                self.assertIs(await Manager().run_action("auto_dream"), result)
            self.assertEqual(calls, ["auto_dream", "auto_dream"])
            self.assertIsNone(plugin._scope.get())

    async def test_sync_dream_is_not_patched(self):
        from qwenpaw.agents.memory.reme_light_memory_manager import ReMeLightMemoryManager
        def synchronous(self):
            return "business"
        with patch.object(ReMeLightMemoryManager, "dream", synchronous, create=True), \
             patch.object(ReMeLightMemoryManager, "run_action", synchronous, create=True):
            self.assertFalse(self.owner._attach_dream())
            self.assertIs(ReMeLightMemoryManager.dream, synchronous)


class ConversionTests(unittest.TestCase):
    def test_cache_none_alias_fallback_preserves_explicit_zero(self):
        for usage, expected in (({"cache_read_input_tokens": None, "cache_input_tokens": 9}, 9),
                                ({"cache_read_input_tokens": 0, "cache_input_tokens": 9}, 0),
                                ({"cache_input_tokens": 9, "prompt_tokens_details": {"cached_tokens": 3}}, 9),
                                ({"cache_read_input_tokens": None, "cache_input_tokens": None, "prompt_tokens_details": {"cached_tokens": 3}}, 3)):
            with self.subTest(usage=usage):
                self.assertEqual(plugin._usage(usage)["gen_ai.usage.cache_read.input_tokens"], expected)
        self.assertEqual(plugin._usage({"cache_read_input_tokens": None}), {})

    def test_provider_endpoint_wrappers_and_active_fallback(self):
        OpenAIChatModel = type("OpenAIChatModel", (), {})
        model = OpenAIChatModel()
        model.client = NS(base_url="https://dashscope.aliyuncs.com/compatible-mode/v1")
        wrapper = NS(_inner=NS(_model=model), base_url="https://api.openai.com/v1")
        self.assertEqual(plugin._provider(wrapper), "dashscope")
        model.client.base_url = "https://api.deepseek.com/v1"
        self.assertEqual(plugin._provider(wrapper), "deepseek")
        model.client.base_url = "https://proxy.example/v1"
        self.assertEqual(plugin._provider(wrapper), "unknown")
        model.qwenpaw_provider_id = " bailian "
        self.assertEqual(plugin._provider(wrapper), "dashscope")

    def test_provider_url_host_boundaries_and_unknown_defaults(self):
        for url in ("https://api.openai.com.evil.example", "https://api.openai.com@evil.example", "https://evil.example/api.openai.com", "file://api.openai.com", "https://[invalid"):
            with self.subTest(url=url):
                self.assertEqual(plugin._provider(NS(base_url=url)), "unknown")
        self.assertEqual(plugin._provider(NS(base_url="https://API.DEEPSEEK.COM./v1")), "deepseek")
        self.assertEqual(plugin._provider(NS(base_url="https://sub.api.moonshot.ai/v1")), "moonshot")
        self.assertEqual(plugin._provider(NS()), "unknown")

    def test_provider_native_mro_cycles_and_broken_metadata_are_safe(self):
        Native = type("DashScopeChatModel", (), {})
        self.assertEqual(plugin._provider(type("CustomModel", (Native,), {})()), "dashscope")
        Ollama = type("OllamaChatModel", (), {})
        local = Ollama()
        local.base_url = "http://localhost:11434"
        self.assertEqual(plugin._provider(local), "ollama")
        cycle = NS(_provider_id="anthropic")
        cycle._inner = cycle
        self.assertEqual(plugin._provider(cycle), "anthropic")
        class Broken:
            @property
            def client(self):
                raise RuntimeError("metadata unavailable")
        self.assertEqual(plugin._provider(Broken()), "unknown")

    def test_tool_result_native_block_list_uses_genai_parts(self):
        block = ToolResultBlock(id="read", name="read_file", output=[TextBlock(text="file content")])
        parts = plugin._parts([block])
        self.assertEqual(parts, [{"type": "tool_call_response", "id": "read", "response": [{"type": "text", "content": "file content"}]}])
        messages = plugin._messages(Msg(name="a", role="assistant", content=[block]))
        self.assertEqual(messages[0]["role"], "tool")
        self.assertEqual(messages[0]["parts"], parts)

    def test_tool_result_json_map_and_scalars_keep_their_shapes(self):
        for value in ({"content": "application-specific", "count": 2}, "plain", 3, None):
            self.assertEqual(plugin._tool_response_parts(value), value)

    def test_skill_manifest_version_fallback_and_native_only_directory(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root) / "workspaces" / "default" / "skills" / "witness"
            directory.mkdir(parents=True)
            (directory / "SKILL.md").write_text("---\nname: witness\ndescription: From disk\n---\nBody")
            (directory.parent.parent / "skill.json").write_text(json.dumps({"skills": {"witness": {"metadata": {"version_text": "9.0"}}}}))
            agent = NS(toolkit=NS(_qp_skills={"witness": {"dir": str(directory)}}))
            fields = plugin._skill_fields(agent, {"skill": "witness"})
            self.assertEqual(fields["gen_ai.skill.id"], "workspace:default:witness")
            self.assertEqual(fields["gen_ai.skill.description"], "From disk")
            self.assertEqual(fields["gen_ai.skill.version"], "9.0")



class WriterTests(unittest.TestCase):
    def test_agent_output_override_and_global_enabled_gate(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {"LOONGSUITE_PILOT_DATA_DIR": root, "AGENT_DATA_COLLECTION_CONFIG": str(Path(root) / "config.json")}):
            config = Path(root) / "config.json"
            writer = plugin.JsonlWriter()
            value = {"agents": {"qwenpaw": {"enabled": True, "collectTrace": True}}, "collectLog": False, "collectTrace": False}
            config.write_text(json.dumps(value))
            writer.write({"test": "agent override"})
            value["enabled"] = False
            config.write_text(json.dumps(value))
            writer.write({"test": "globally disabled"})
            value["enabled"] = True
            value.update(collectLog=True, collectTrace=True)
            value["agents"]["qwenpaw"].update(collectLog=False, collectTrace=False)
            config.write_text(json.dumps(value))
            writer.write({"test": "agent outputs disabled"})
            self.assertEqual(json.loads(next(Path(root).rglob("*.jsonl")).read_text()), {"test": "agent override"})

    def test_explicit_output_off_on_is_dynamic_without_unloading(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {"LOONGSUITE_PILOT_DATA_DIR": root, "AGENT_DATA_COLLECTION_CONFIG": str(Path(root) / "config.json")}):
            config = Path(root) / "config.json"
            value = {"agents": {"qwenpaw": {"enabled": True}}, "collectLog": False, "collectTrace": False}
            config.write_text(json.dumps(value))
            writer = plugin.JsonlWriter()
            writer.write({"test": "off"})
            self.assertEqual(list(Path(root).rglob("*.jsonl")), [])
            value["collectTrace"] = True
            config.write_text(json.dumps(value))
            writer.write({"test": "on"})
            output = next(Path(root).rglob("*.jsonl"))
            value["collectTrace"] = False
            config.write_text(json.dumps(value))
            writer.write({"test": "off again"})
            self.assertEqual(json.loads(output.read_text()), {"test": "on"})

    def test_output_gate_preserves_unspecified_defaults(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {"LOONGSUITE_PILOT_DATA_DIR": root, "AGENT_DATA_COLLECTION_CONFIG": str(Path(root) / "config.json")}):
            config = Path(root) / "config.json"
            writer = plugin.JsonlWriter()
            for value in ({"agents": {"qwenpaw": {}}, "collectLog": False}, {"collectLog": False, "collectTrace": False}, {"agents": {"qwenpaw": {}}, "collectLog": True, "collectTrace": False}):
                config.write_text(json.dumps(value))
                writer.write({"test": "default"})
            self.assertEqual(len(next(Path(root).rglob("*.jsonl")).read_text().splitlines()), 3)
    def test_private_jsonl_and_distinct_ids(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {"LOONGSUITE_PILOT_DATA_DIR": root}):
            writer = plugin.JsonlWriter()
            writer.write({"test": "value"})
            output = next(Path(root).rglob("*.jsonl"))
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(output.parent.stat().st_mode), 0o700)
            self.assertEqual(json.loads(output.read_text()), {"test": "value"})

    def test_capture_off_removes_content_and_disable_stops_writes(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {"LOONGSUITE_PILOT_DATA_DIR": root}):
            config = Path(root) / "config.json"
            config.write_text(json.dumps({"agents": {"qwenpaw": {"captureMessageContent": False}}}))
            writer = plugin.JsonlWriter()
            writer.write({"event.name": "llm.request", "gen_ai.input.messages": ["private"], "error.message": "private"})
            output = next(Path(root).rglob("*.jsonl"))
            self.assertEqual(json.loads(output.read_text()), {"event.name": "llm.request"})
            config.write_text(json.dumps({"agents": {"qwenpaw": {"enabled": False}}}))
            writer.write({"event.name": "llm.response"})
            self.assertEqual(len(output.read_text().splitlines()), 1)


    def test_write_failure_is_fail_open(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {"LOONGSUITE_PILOT_DATA_DIR": root}):
            with patch("os.open", side_effect=PermissionError("denied")):
                plugin.JsonlWriter().write({"test": "value"})


if __name__ == "__main__":
    unittest.main()
