
barrier = threading.Barrier(2)
failures = []
def conversation(turn, sender, start, delta):
    try:
        data = dict(payload("shared"), task_id=turn, turn_id=turn,
                    api_request_id=turn + "-api", sender_id=sender, platform="dingtalk")
        ctx.hooks["pre_llm_call"](**data, user_message=turn)
        clock.value = start
        ctx.hooks["pre_api_request"](**data)
        barrier.wait(timeout=5)
        AIAgent("shared")._interruptible_streaming_api_call({"delta_times": [delta]})
        ctx.hooks["post_api_request"](**data, finish_reason="stop",
                                     usage={"input_tokens": 2, "output_tokens": 1})
        ctx.hooks["post_llm_call"](**data, user_message=turn, assistant_response="done")
    except BaseException as error:
        failures.append(error)
threads = [threading.Thread(target=conversation, args=("foreground", "im-user-A", 100, 130)),
           threading.Thread(target=conversation, args=("background", "", 1000, 1900))]
for thread in threads:
    thread.start()
for thread in threads:
    thread.join(timeout=5)
    assert not thread.is_alive()
assert not failures, failures
