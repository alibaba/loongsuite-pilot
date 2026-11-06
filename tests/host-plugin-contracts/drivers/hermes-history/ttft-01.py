
import contextvars
# Each hook receives a copy, exactly as the current Hermes bounded dispatcher.
contextvars.copy_context().run(begin, "bounded", 1_000_000_000)
agent = AIAgent("bounded")
agent._current_task_id = "turn-bounded"
agent._interruptible_streaming_api_call({"delta_times": [1_250_000_000]})
end("bounded")
flush("bounded")
