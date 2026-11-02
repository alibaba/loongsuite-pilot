
begin("invalid-duration", start=100)
AIAgent("invalid-duration")._interruptible_streaming_api_call({"delta_times": [__FIRST_DELTA__]})
end("invalid-duration")
flush("invalid-duration")
