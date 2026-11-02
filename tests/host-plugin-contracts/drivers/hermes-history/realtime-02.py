
import importlib.util, json, os, pathlib, sys
spec = importlib.util.spec_from_file_location('pilot', sys.argv[1])
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
p.MAX_ACTIVE_TURNS = 2
p._report_internal_error = lambda *args: None
writer = p._write_records
def emit(i):
    p._safe_callback('pre_api_request')(session_id='bounded', task_id='t'+str(i), turn_id='t'+str(i), api_request_id='r'+str(i))
emit(0)
emit(1)
def fail(records): raise OSError('unwritable directory')
p._write_records = fail
for i in range(2, 8):
    emit(i)
    assert len(p._SESSIONS['bounded']['turns']) <= 2, 'active turns exceeded bound'
    assert len(p._EVICTED_TURNS) <= 2, 'retry turns exceeded bound'
    current = next(t for t in p._SESSIONS['bounded']['turns'].values() if t['observer_turn_id'] == 't'+str(i))
    assert len(current['apis']) == 1, 'failed eviction aborted the new request'
state = p._SESSIONS['bounded']
active = next(iter(state['turns'].values()))
identity = active['trace_id'], active['apis'][0]['span_id']
p._write_records = writer
# The previously oldest active request must not be closed by its own hook.
emit(6)
assert active in state['turns'].values()
assert active['trace_id'] == identity[0] and active['apis'][0]['span_id'] == identity[1]
p._flush_at_exit()
p._flush_at_exit()
records = [json.loads(line) for f in pathlib.Path(os.environ['LOONGSUITE_PILOT_DATA_DIR']).glob('logs/hermes-agent/*.jsonl') for line in f.read_text().splitlines()]
terminal = [r for r in records if r.get('gen_ai.turn.end')]
assert sorted(r['gen_ai.turn.id'] for r in terminal) == ['t4','t5','t6','t7']
assert len({r['event.id'] for r in records}) == len(records)
assert not p._EVICTED_TURNS and not p._SESSIONS
# Session eviction uses the same globally bounded retry area and must not keep
# the evicted session's other active turns reachable through each snapshot.
p.MAX_SESSIONS = 2
p._write_records = fail
for i in range(8):
    p._safe_callback('pre_api_request')(session_id='s'+str(i), turn_id='s'+str(i), api_request_id='sr'+str(i))
    assert len(p._SESSIONS) <= 2 and len(p._EVICTED_TURNS) <= 2
assert all(len(snapshot['turns']) == 1 for snapshot, turn in p._EVICTED_TURNS.values())
p._write_records = writer
p._flush_at_exit()
assert not p._EVICTED_TURNS and not p._SESSIONS
print(json.dumps({'terminal': len(terminal)}))
