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
import asyncio, contextvars, importlib.util, json, pathlib, sys, threading, types
runtime = types.ModuleType("run_agent")
class AIAgent:
    session_id = "same-session"
    def run_conversation(self, behavior):
        return behavior(self)
runtime.AIAgent = AIAgent
sys.modules["run_agent"] = runtime
early = ${earlyRegistration ? 'True' : 'False'}
if early:
    loop = types.ModuleType("agent.conversation_loop")
    loop.run_conversation = AIAgent.run_conversation
    sys.modules["agent.conversation_loop"] = loop
    del runtime.AIAgent
spec = importlib.util.spec_from_file_location("plugin", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
class Context:
    def __init__(self): self.hooks = {}
    def register_hook(self, name, callback): self.hooks[name] = callback
ctx = Context()
module.register(ctx)
if early:
    runtime.AIAgent = AIAgent
    AIAgent.run_conversation = lambda self, behavior: loop.run_conversation(self, behavior)
def begin(label):
    payload = dict(session_id="same-session", task_id=label, turn_id=label, user_message=label, model="test")
    ctx.hooks["pre_llm_call"](**payload)
    ctx.hooks["pre_api_request"](**dict(payload, api_call_count=1, api_request_id=label))
    ctx.hooks["api_request_error"](**dict(payload, api_call_count=1, api_request_id=label, error={"type":"TestError", "message":"synthetic"}))
    return payload
def pending(): return sum(len(s["turns"]) for s in module._SESSIONS.values())
def terminals():
    return sum(json.loads(line).get("gen_ai.turn.end") is True
        for file in module._data_dir().joinpath("logs/hermes-agent").glob("*.jsonl")
        for line in file.read_text().splitlines())
${driver}
`, plugin], {
      encoding: 'utf8', env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: root,
        LOONGSUITE_PILOT_USER_ID: '', LOONGSUITE_USER_ID: '',
        LOONGSUITE_PILOT_SPAN_ATTRIBUTES: '', PYTHONDONTWRITEBYTECODE: '1' },
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout.trim());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('Hermes native run completion observation', () => {
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
        begin("failed-%s" % i)
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
});
