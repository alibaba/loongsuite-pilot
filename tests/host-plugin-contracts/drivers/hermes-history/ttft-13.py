
begin("retry")
failure = ValueError("native callback failure")
def callback():
    raise failure
try:
    AIAgent("retry")._interruptible_streaming_api_call({"delta_times": [140]}, on_first_delta=callback)
    raise AssertionError("callback exception was swallowed")
except ValueError as caught:
    extra["same_exception"] = caught is failure
end("retry", error=True)
begin("retry", start=200, count=2)
AIAgent("retry")._interruptible_streaming_api_call({"delta_times": [290]})
end("retry", count=2)
flush("retry")
