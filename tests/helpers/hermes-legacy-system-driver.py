# Synthetic Hermes v2026.4.16 builder/hook contract; no provider calls.
import concurrent.futures
import importlib.util
import json
import sys
import threading
import types

hermes = types.ModuleType("hermes_cli")
hermes.__version__, hermes.__release_date__ = "0.10.0", "2026.4.16"
sys.modules["hermes_cli"] = hermes
sys.modules["__main__"] = types.ModuleType("__main__")

def load_plugin():
    spec = importlib.util.spec_from_file_location("pilot_legacy_system", sys.argv[1])
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)
    class Context:
        def __init__(self): self.hooks = {}
        def register_hook(self, name, callback): self.hooks[name] = callback
    ctx = Context()
    plugin.register(ctx)
    return plugin, ctx

# Like native discovery, registration can precede AIAgent's definition.
plugin, ctx = load_plugin()
class AIAgent:
    def __init__(self, session="fixture-session", api_mode="chat_completions"):
        self.session_id, self.api_mode = session, api_mode
        self._force_ascii_payload = False
        self.calls = 0
        self.preflight_calls = 0
        self.request_overrides = {}
    def _build_api_kwargs(self, api_messages):
        self.calls += 1
        if isinstance(api_messages, Exception): raise api_messages
        self.last_messages = api_messages
        system = next((m['content'] for m in api_messages if m.get('role') == 'system'), '')
        history = [m for m in api_messages if m.get('role') != 'system']
        if self.api_mode == 'anthropic_messages':
            self.last_body = {'system': system, 'messages': history}
        elif self.api_mode == 'bedrock_converse':
            self.last_body = {'system': [{'text': system}], 'messages': history}
        elif self.api_mode == 'codex_responses':
            self.last_body = {'instructions': system, 'input': history}
        else:
            self.last_body = {"messages": api_messages}
        self.last_body.update(self.request_overrides)
        return self.last_body

    def _preflight_codex_api_kwargs(self, api_kwargs, *, allow_stream=False):
        self.preflight_calls += 1
        if isinstance(api_kwargs, Exception): raise api_kwargs
        instructions = api_kwargs.get('instructions')
        instructions = '' if instructions is None else str(instructions)
        self.last_preflight_body = dict(api_kwargs, instructions=instructions.strip() or 'fixture default identity')
        return self.last_preflight_body

native = AIAgent._build_api_kwargs
native_preflight = AIAgent._preflight_codex_api_kwargs
runtime = types.ModuleType("run_agent")
runtime.AIAgent = AIAgent
sys.modules["run_agent"] = runtime
extra = {}

def sanitize_ascii(value):
    if isinstance(value, dict):
        for key, item in value.items():
            value[key] = item.encode('ascii', errors='ignore').decode('ascii') if isinstance(item, str) else sanitize_ascii(item)
    elif isinstance(value, list):
        for index, item in enumerate(value):
            value[index] = item.encode('ascii', errors='ignore').decode('ascii') if isinstance(item, str) else sanitize_ascii(item)
    return value

def fields(session, count=1):
    return {"session_id": session, "task_id": "task-" + session,
            "api_call_count": count, "api_mode": "chat_completions",
            "model": "fixture-model", "provider": "fixture-provider", "platform": "cli"}

def begin(session="fixture-session"):
    ctx.hooks["pre_llm_call"](session_id=session, user_message="fixture input",
                             conversation_history=[{"role": "user", "content": "fixture input"}])

def observe(session="fixture-session", count=1, **overrides):
    payload = dict(fields(session, count), **overrides)
    ctx.hooks["pre_api_request"](**payload)
    ctx.hooks["post_api_request"](**payload, finish_reason="stop",
                                  usage={"input_tokens": 2, "output_tokens": 1, "total_tokens": 3})

def request(agent, text, count=1, **overrides):
    messages = [{"role": "system", "content": text}, {"role": "user", "content": "fixture input"}]
    body = agent._build_api_kwargs(messages)
    assert body is agent.last_body and agent.last_messages is messages
    if agent._force_ascii_payload:
        sanitize_ascii(body)
    if agent.api_mode == 'codex_responses':
        body = agent._preflight_codex_api_kwargs(body, allow_stream=False)
        assert body is agent.last_preflight_body
    observe(agent.session_id, count, **dict({"api_mode": agent.api_mode}, **overrides))
    return body

def finish(session="fixture-session"):
    ctx.hooks["post_llm_call"](session_id=session, user_message="fixture input",
                             assistant_response="fixture output")
