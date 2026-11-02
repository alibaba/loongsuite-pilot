
barrier = threading.Barrier(2)
failures = []
def conversation(session, start, delta):
    try:
        begin(session, start)
        barrier.wait(timeout=5)
        AIAgent(session)._interruptible_streaming_api_call({"delta_times": [delta]})
        end(session)
        flush(session)
    except BaseException as error:
        failures.append(error)
threads = [threading.Thread(target=conversation, args=("one", 100, 130)),
           threading.Thread(target=conversation, args=("two", 1000, 1900))]
for thread in threads:
    thread.start()
for thread in threads:
    thread.join(timeout=5)
    assert not thread.is_alive()
assert not failures, failures
