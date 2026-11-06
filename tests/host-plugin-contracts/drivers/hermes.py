import importlib.util
import json
import pathlib
import sys
import threading
import types

# Simulated Hermes 0.19 native callback contract; fixture event ordering is real-derived.
runtime = types.ModuleType("run_agent")
class AIAgent:
    api_mode = "chat_completions"
    def __init__(self, session_id):
        self.session_id = session_id
    def _interruptible_streaming_api_call(self, api_kwargs, *, on_first_delta=None):
        worker = threading.Thread(target=on_first_delta)
        worker.start()
        worker.join()
runtime.AIAgent = AIAgent
sys.modules["run_agent"] = runtime

plugin_path = pathlib.Path(sys.argv[1])
fixture_path = pathlib.Path(sys.argv[2])
spec = importlib.util.spec_from_file_location("pilot_hermes_plugin", plugin_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class Context:
    def __init__(self):
        self.hooks = {}
    def register_hook(self, name, callback):
        self.hooks[name] = callback

ctx = Context()
module.register(ctx)
for line in fixture_path.read_text(encoding="utf-8").splitlines():
    event = json.loads(line)
    count = event["payload"].get("api_call_count", 0)
    module.time.perf_counter_ns = lambda: 1_000_000_000
    ctx.hooks[event["hook"]](**event["payload"])
    if event["hook"] == "pre_api_request":
        module.time.perf_counter_ns = lambda: 1_000_000_000 + count * 125_000_000
        AIAgent(event["payload"]["session_id"])._interruptible_streaming_api_call({})
