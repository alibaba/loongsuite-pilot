
begin("fallback")
agent = AIAgent("fallback")
extra["result"] = agent._interruptible_streaming_api_call(
    {"non_streaming_fallback": True, "delta_times": [180]}, on_first_delta=lambda: "full-response-ready")
extra["disabled_streaming"] = agent._disable_streaming
end("fallback")
flush("fallback")
