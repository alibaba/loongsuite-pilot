
import contextvars
contextvars.copy_context().run(begin, "ambiguous", 100, 1)
contextvars.copy_context().run(begin, "ambiguous", 200, 2)
agent = AIAgent("ambiguous")
agent._current_task_id = "turn-ambiguous"
agent._interruptible_streaming_api_call({"delta_times": [300]})
end("ambiguous", 1)
agent._current_task_id = "different-turn"
agent._interruptible_streaming_api_call({"delta_times": [400]})
end("ambiguous", 2)
flush("ambiguous")
