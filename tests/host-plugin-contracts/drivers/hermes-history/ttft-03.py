
helpers = types.ModuleType("agent.chat_completion_helpers")
helpers.interruptible_streaming_api_call = native_method
sys.modules["agent.chat_completion_helpers"] = helpers
def forwarder(self, *args, **kwargs):
    return helpers.interruptible_streaming_api_call(self, *args, **kwargs)
forwarder.__module__ = "agent.lazy_forward"
AIAgent._interruptible_streaming_api_call = forwarder
begin("lazy", start=1_000_000_000)
seen = []
result = AIAgent("lazy")._interruptible_streaming_api_call(
    {"delta_times": [1_250_000_000]}, on_first_delta=lambda: seen.append("called"))
end("lazy")
flush("lazy")
extra.update(seen=seen, facade_unchanged=AIAgent._interruptible_streaming_api_call is forwarder)
