
begin("original-plugin")
AIAgent("original-plugin")._interruptible_streaming_api_call({"delta_times": [150]})
end("original-plugin")
flush("original-plugin")
installed = AIAgent._interruptible_streaming_api_call
rediscovered_spec = importlib.util.spec_from_file_location("rediscovered_pilot_plugin", sys.argv[1])
plugin = importlib.util.module_from_spec(rediscovered_spec)
rediscovered_spec.loader.exec_module(plugin)
ctx = Context()
plugin.register(ctx)
begin("rediscovered-plugin", start=200)
extra["same_wrapper"] = installed is AIAgent._interruptible_streaming_api_call
AIAgent("rediscovered-plugin")._interruptible_streaming_api_call({"delta_times": [280]})
end("rediscovered-plugin")
flush("rediscovered-plugin")
