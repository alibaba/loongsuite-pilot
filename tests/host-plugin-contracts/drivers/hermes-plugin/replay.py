
import importlib.util
import json
import pathlib
import sys

plugin_path = pathlib.Path(sys.argv[1])
events_path = pathlib.Path(sys.argv[2])
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
from concurrent.futures import ThreadPoolExecutor
workers = {}
for line in events_path.read_text(encoding="utf-8").splitlines():
    event = json.loads(line)
    if event.get("thread"):
        worker = workers.setdefault(event["thread"], ThreadPoolExecutor(max_workers=1))
        worker.submit(ctx.hooks[event["hook"]], **event["payload"]).result()
    else:
        ctx.hooks[event["hook"]](**event["payload"])
for worker in workers.values():
    worker.shutdown()
print(json.dumps({"hooks": sorted(ctx.hooks), "activeTurns": sum(len(state["turns"]) for state in module._SESSIONS.values()), "sessions": len(module._SESSIONS)}))
