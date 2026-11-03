
import importlib.util, json, pathlib, sys, types
spec = importlib.util.spec_from_file_location('pilot_hermes', sys.argv[1])
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
hooks = {}
p.register(types.SimpleNamespace(register_hook=lambda name, cb: hooks.update({name: cb})))
for event in json.loads(pathlib.Path(sys.argv[2]).read_text()):
    hooks[event['hook']](**event['payload'])
