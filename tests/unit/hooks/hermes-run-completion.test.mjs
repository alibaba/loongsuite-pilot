import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const plugin = process.env.PILOT_HERMES_COMPLETION_TEST_PLUGIN
  || path.resolve('assets/plugins/hermes-agent/loongsuite-pilot/__init__.py');

// Native-loop coverage is recorded separately with Hermes v2026.6.5. This
// focused fault-injection suite asserts wrapper semantics and concurrent scope
// ownership without provider credentials or a Hermes dependency in CI.
function run(driver, earlyRegistration = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-hermes-completion-'));
  try {
    const result = spawnSync('python3', ['-c', `
import asyncio, contextvars, importlib.util, io, json, pathlib, sys, threading, types
runtime = types.ModuleType("run_agent")
class AIAgent:
    session_id = "same-session"
    def run_conversation(self, behavior):
        return behavior(self)
runtime.AIAgent = AIAgent
native_run = AIAgent.run_conversation
sys.modules["run_agent"] = runtime
# Keep the legacy-fallback cases isolated even when Python has Hermes installed.
sys.modules["agent.conversation_loop"] = None
early = ${earlyRegistration === true ? 'True' : 'False'}
deferred = ${earlyRegistration === 'deferred' ? 'True' : 'False'}
if early or deferred:
    loop = types.ModuleType("agent.conversation_loop")
    if early: loop.run_conversation = native_run
    sys.modules["agent.conversation_loop"] = loop
    del runtime.AIAgent
spec = importlib.util.spec_from_file_location("plugin", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
class Context:
    def __init__(self): self.hooks = {}
    def register_hook(self, name, callback): self.hooks[name] = callback
ctx = Context()
diagnostics = io.StringIO()
if deferred: sys.stderr = diagnostics
module.register(ctx)
if early or deferred:
    runtime.AIAgent = AIAgent
    AIAgent.run_conversation = lambda self, behavior: loop.run_conversation(self, behavior)
def begin(label, session_id="same-session"):
    payload = dict(session_id=session_id, task_id=label, turn_id=label, user_message=label, model="test")
    ctx.hooks["pre_llm_call"](**payload)
    ctx.hooks["pre_api_request"](**dict(payload, api_call_count=1, api_request_id=label))
    ctx.hooks["api_request_error"](**dict(payload, api_call_count=1, api_request_id=label, error={"type":"TestError", "message":"synthetic"}))
    return payload
def pending(): return sum(len(s["turns"]) for s in module._SESSIONS.values())
def records():
    return [json.loads(line)
        for file in module._data_dir().joinpath("logs/hermes-agent").glob("*.jsonl")
        for line in file.read_text().splitlines()]
def terminals():
    return sum(row.get("gen_ai.turn.end") is True for row in records())
${driver}
`, plugin], {
      encoding: 'utf8', env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: root,
        LOONGSUITE_PILOT_USER_ID: '', LOONGSUITE_USER_ID: '',
        LOONGSUITE_PILOT_SPAN_ATTRIBUTES: '', PYTHONDONTWRITEBYTECODE: '1' },
    });
    expect(result.status, result.error?.message || result.stderr || result.signal).toBe(0);
    return JSON.parse(result.stdout.trim());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('Hermes native run completion observation', () => {
  it('follows native session rotation before an early return without creating an empty old turn', () => {
    expect(run(`
agent = AIAgent()
answer = object()
def business(agent):
    ctx.hooks["pre_llm_call"](session_id=agent.session_id, task_id="rotation", turn_id="rotation", user_message="rotation", model="test")
    agent.session_id = "rotated-session"
    payload = dict(session_id=agent.session_id, task_id="rotation", turn_id="rotation", user_message="rotation", model="test", api_call_count=1, api_request_id="rotated-api")
    ctx.hooks["pre_api_request"](**payload)
    ctx.hooks["api_request_error"](**dict(payload, error={"type":"TestError"}))
    return answer
result = agent.run_conversation(business)
rows = records()
print(json.dumps(dict(same=result is answer, pending=pending(), terminals=terminals(), sessions=sorted({r["gen_ai.session.id"] for r in rows}), capable=all(r.get("agent.hermes.native_run_observer") is True for r in rows))))
`)).toEqual({ same: true, pending: 0, terminals: 1, sessions: ['rotated-session'], capable: true });
  });

  it('keeps rotated native calls and nested child ownership separate', () => {
    expect(run(`
agent = AIAgent()
def owned_begin(agent, label):
    payload = dict(session_id=agent.session_id, task_id=label, turn_id=label, user_message=label, model="test")
    ctx.hooks["pre_llm_call"](**payload)
    ctx.hooks["pre_api_request"](**dict(payload, api_call_count=1, api_request_id=label))
    ctx.hooks["api_request_error"](**dict(payload, api_call_count=1, api_request_id=label, error={"type":"TestError"}))
def child_call(child): owned_begin(child, "child")
def business(agent):
    agent.session_id = "first-rotation"
    owned_begin(agent, "outer-first")
    child = AIAgent()
    child.session_id = "same-session"
    child.run_conversation(child_call)
    during = pending()
    agent.session_id = "second-rotation"
    owned_begin(agent, "outer-second")
    return during
during = agent.run_conversation(business)
print(json.dumps(dict(during=during, pending=pending(), terminals=terminals())))
`)).toEqual({ during: 1, pending: 0, terminals: 3 });
  });

  it('advertises capability only for turns actually owned by an observed call', () => {
    expect(run(`
begin("unobserved")
unobserved = records()
def business(agent):
    begin("observed")
    return "ok"
AIAgent().run_conversation(business)
observed = [r for r in records() if r["gen_ai.turn.id"] == "observed"]
print(json.dumps(dict(unmarked=all("agent.hermes.native_run_observer" not in r for r in unobserved), capable=all(r.get("agent.hermes.native_run_observer") is True for r in observed), pending=pending(), terminals=terminals())))
`)).toEqual({ unmarked: true, capable: true, pending: 1, terminals: 1 });
  });

  it('diagnoses a missing entry once and retries after native import finishes', () => {
    expect(run(`
clock = [0.0]
module.time.monotonic = lambda: clock[0]
for i in range(3):
    payload = begin("uncovered-%s" % i)
    ctx.hooks["on_session_end"](**payload)
before = records()
loop.run_conversation = native_run
clock[0] = 10.0
def ordinary(agent):
    payload = begin("install-late")
    ctx.hooks["on_session_end"](**payload)
    return "ordinary"
AIAgent().run_conversation(ordinary)
def business(agent):
    begin("covered-late")
    return "ok"
result = AIAgent().run_conversation(business)
covered = [r for r in records() if r["gen_ai.turn.id"] == "covered-late"]
print(json.dumps(dict(result=result, pending=pending(), terminals=terminals(), diagnostic=diagnostics.getvalue().count("native run observer unavailable"), unmarked=all("agent.hermes.native_run_observer" not in r for r in before), capable=all(r.get("agent.hermes.native_run_observer") is True for r in covered))))
`, 'deferred')).toEqual({ result: 'ok', pending: 0, terminals: 5, diagnostic: 1, unmarked: true, capable: true });
  });

  it('covers the first turn when registration precedes AIAgent class definition', () => {
    expect(run(`
def business(agent):
    begin("first-turn")
    return "ok"
print(json.dumps(dict(result=AIAgent().run_conversation(business), pending=pending(), terminals=terminals())))
`, true)).toEqual({ result: 'ok', pending: 0, terminals: 1 });
  });

  it('closes an early return once, preserving the exact application result', () => {
    expect(run(`
answer = object()
calls = []
def business(agent):
    calls.append(1)
    begin("failed")
    return answer
result = AIAgent().run_conversation(business)
print(json.dumps(dict(same=result is answer, calls=len(calls), pending=pending(), terminals=terminals())))
`)).toEqual({ same: true, calls: 1, pending: 0, terminals: 1 });
  });

  it('preserves exception identity, cancellation and an unaffected sibling call', () => {
    expect(run(`
errors = [ValueError("app error"), KeyboardInterrupt("cancel"), asyncio.CancelledError("async cancel")]
same = []
for i, error in enumerate(errors):
    def business(agent):
        agent.session_id = "failed-session-%s" % i
        begin("failed-%s" % i, agent.session_id)
        raise error
    try: AIAgent().run_conversation(business)
    except BaseException as actual: same.append(actual is error)
before = pending()
def sibling(agent):
    payload = begin("sibling")
    ctx.hooks["on_session_end"](**payload)
    return "ok"
print(json.dumps(dict(same=same, before=before, result=AIAgent().run_conversation(sibling), pending=pending())))
`)).toEqual({ same: [true, true, true], before: 0, result: 'ok', pending: 0 });
  });

  it('does not close a live overlapping turn when another native call returns', () => {
    expect(run(`
ready = threading.Event()
release = threading.Event()
def background(agent):
    begin("background")
    ready.set()
    release.wait(5)
worker = threading.Thread(target=lambda: AIAgent().run_conversation(background))
worker.start()
assert ready.wait(5)
def foreground(agent):
    begin("foreground")
    return "done"
AIAgent().run_conversation(foreground)
during = pending()
release.set()
worker.join(5)
print(json.dumps(dict(during=during, after=pending())))
`)).toEqual({ during: 1, after: 0 });
  });

  it('fails open when telemetry finalization raises and restores its scope', () => {
    expect(run(`
original = module._flush_turn
def broken(*args): raise OSError("synthetic disk failure")
module._flush_turn = broken
class BrokenStderr:
    def write(self, *args): raise OSError("stderr closed")
real_stderr = sys.stderr
sys.stderr = BrokenStderr()
def business(agent):
    begin("disk-failure")
    return "unchanged"
result = AIAgent().run_conversation(business)
module._flush_turn = original
def sibling(agent):
    begin("sibling")
    return "ok"
next_result = AIAgent().run_conversation(sibling)
sys.stderr = real_stderr
print(json.dumps(dict(result=result, next=next_result, pending=pending())))
`)).toEqual({ result: 'unchanged', next: 'ok', pending: 1 });
  });

  it('is idempotent and tracks hooks dispatched in copied worker contexts', () => {
    expect(run(`
module.register(ctx)
module.register(ctx)
def business(agent):
    context = contextvars.copy_context()
    worker = threading.Thread(target=lambda: context.run(begin, "worker"))
    worker.start()
    worker.join(5)
    return "ok"
result = AIAgent().run_conversation(business)
print(json.dumps(dict(result=result, pending=pending(), terminals=terminals())))
`)).toEqual({ result: 'ok', pending: 0, terminals: 1 });
  });

  it('releases call ownership even when a copied context outlives the native invocation', () => {
    expect(run(`
saved = []
def business(agent):
    begin("completed")
    saved.append(contextvars.copy_context())
    return "ok"
AIAgent().run_conversation(business)
scope = saved[0].run(module._NATIVE_RUN_SCOPE.get)
saved[0].run(begin, "late-uncovered")
late = [r for r in records() if r["gen_ai.turn.id"] == "late-uncovered"]
print(json.dumps(dict(released=scope["agent"] is None and not scope["turns"] and not scope["sessions"], unmarked=all("agent.hermes.native_run_observer" not in r for r in late), terminals=terminals())))
`)).toEqual({ released: true, unmarked: true, terminals: 1 });
  });
});
