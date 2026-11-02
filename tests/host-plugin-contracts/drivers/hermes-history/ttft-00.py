
begin('streaming', start=100)
writer_entered, release_writer, delivered = threading.Event(), threading.Event(), threading.Event()
original_writer = plugin._write_records
def slow_writer(records):
    writer_entered.set()
    assert release_writer.wait(3), 'test writer timed out'
    original_writer(records)
plugin._write_records = slow_writer
# Supply actual input so this request enters I/O rather than input staging.
writer = threading.Thread(target=lambda: begin('other-session', start=110, user_message='other request'))
writer.start()
assert writer_entered.wait(2)
result, errors = [], []
def stream():
    try:
        # Capture request context on this thread without consulting the state lock.
        plugin._TTFT_API.set(api)
        result.append(AIAgent('streaming')._interruptible_streaming_api_call({'delta_times': [140]}, on_first_delta=delivered.set))
    except BaseException as error: errors.append(str(error))
api = next(iter(plugin._SESSIONS['streaming']['turns'].values()))['apis'][0]
stream_thread = threading.Thread(target=stream)
stream_thread.start()
try:
    extra['native_delivered_before_writer_released'] = delivered.wait(1)
    stream_thread.join(timeout=.2)
    extra['stream_completed_before_writer_released'] = not stream_thread.is_alive()
finally:
    release_writer.set()
    writer.join(timeout=3)
    stream_thread.join(timeout=3)
    plugin._write_records = original_writer
assert not errors, errors
end('streaming')
flush('streaming')
