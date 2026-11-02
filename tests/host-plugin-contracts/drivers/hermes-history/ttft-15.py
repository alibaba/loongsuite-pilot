
begin("clock-failure")
extra["result"] = AIAgent("clock-failure")._interruptible_streaming_api_call(
    {"delta_times": [RuntimeError("clock unavailable")]}, on_first_delta=lambda: "still-called")
end("clock-failure")
flush("clock-failure")
