
begin("late-delta")
saved = []
AIAgent("late-delta")._interruptible_streaming_api_call(
    {"save_callback": saved}, on_first_delta=lambda: "preserved-after-close")
end("late-delta", error=True)
begin("late-delta", start=200, count=2)
clock.value = 250
extra["callback_result"] = saved[0]()
AIAgent("late-delta")._interruptible_streaming_api_call({"delta_times": []})
end("late-delta", count=2)
flush("late-delta")
