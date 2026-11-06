
begin("first", start=1_000_000_000)
seen = []
def callback(value, *, marker):
    seen.append([value, marker])
    return "callback-result"
agent = AIAgent("first")
result = agent._interruptible_streaming_api_call(
    {"delta_times": [1_125_000_000, 1_900_000_000], "args": [42], "kwargs": {"marker": "kept"}},
    on_first_delta=callback)
end("first")
flush("first")
extra.update(result=result, seen=seen, calls=agent.calls)
