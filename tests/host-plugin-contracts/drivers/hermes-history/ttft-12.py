
begin("retry", count=1)
end("retry", count=1, error=True)
# A stale unconsumed pre context must not update the closed request.
AIAgent("retry")._interruptible_streaming_api_call({"delta_times": [150]})
begin("retry", start=200, count=2)
AIAgent("retry")._interruptible_streaming_api_call({"delta_times": []})
end("retry", count=2)
flush("retry")
