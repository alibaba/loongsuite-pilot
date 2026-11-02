
import importlib.util
import json
import pathlib
import sys
import threading
import types

# The test driver is not Hermes' __main__ entrypoint.
sys.modules["__main__"] = types.ModuleType("__main__")

spec = importlib.util.spec_from_file_location("pilot_hermes_plugin", sys.argv[1])
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)

clock = threading.local()
def monotonic_ns():
    value = clock.value
    if isinstance(value, Exception):
        raise value
    return value
plugin.time.perf_counter_ns = monotonic_ns

class Context:
    def __init__(self):
        self.hooks = {}
    def register_hook(self, name, callback):
        self.hooks[name] = callback
ctx = Context()
plugin.register(ctx)

class AIAgent:
    def __init__(self, session_id, api_mode="chat_completions"):
        self.session_id = session_id
        self.api_mode = api_mode
        self.calls = 0
    def _interruptible_streaming_api_call(self, api_kwargs, *, on_first_delta=None):
        self.calls += 1
        if "save_callback" in api_kwargs:
            api_kwargs["save_callback"].append(on_first_delta)
        values, errors = [], []
        def worker():
            try:
                if api_kwargs.get("non_streaming_fallback"):
                    self._disable_streaming = True
                for delta_ns in api_kwargs.get("delta_times", []):
                    clock.value = delta_ns
                    if on_first_delta is not None:
                        values.append(on_first_delta(*api_kwargs.get("args", []), **api_kwargs.get("kwargs", {})))
            except BaseException as error:
                errors.append(error)
        thread = threading.Thread(target=worker)
        thread.start()
        thread.join(timeout=5)
        assert not thread.is_alive(), "stream callback deadlocked"
        if errors:
            raise errors[0]
        return {"values": values, "response": "native-result"}

native_method = AIAgent._interruptible_streaming_api_call
runtime = types.ModuleType("run_agent")
runtime.AIAgent = AIAgent
sys.modules["run_agent"] = runtime

def payload(session, count=1):
    return {"session_id": session, "task_id": "turn-" + session,
            "api_request_id": session + "-api-" + str(count), "api_call_count": count,
            "model": "fixture-model", "provider": "fixture-provider", "platform": "cli"}

def begin(session, start=100, count=1, **input_fields):
    clock.value = start
    ctx.hooks["pre_api_request"](**payload(session, count), **input_fields)

def end(session, count=1, error=False):
    if error:
        ctx.hooks["api_request_error"](**payload(session, count), error={"type": "FixtureError", "message": "fixture"})
    else:
        ctx.hooks["post_api_request"](**payload(session, count), finish_reason="stop", usage={"input_tokens": 2, "output_tokens": 1})

def flush(session):
    ctx.hooks["post_llm_call"](session_id=session, user_message="fixture", assistant_response="done")

extra = {}
