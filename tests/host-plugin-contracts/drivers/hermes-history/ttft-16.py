
del sys.modules["run_agent"]
begin("early")
end("early")
assert AIAgent._interruptible_streaming_api_call is native_method
sys.modules["run_agent"] = runtime
begin("late")
installed = AIAgent._interruptible_streaming_api_call
assert installed is not native_method
AIAgent("late")._interruptible_streaming_api_call({"delta_times": [150]})
end("late")
flush("late")
plugin.register(ctx)
begin("again", start=200)
extra["same_wrapper"] = installed is AIAgent._interruptible_streaming_api_call
AIAgent("again")._interruptible_streaming_api_call({"delta_times": [280]})
end("again")
flush("again")
