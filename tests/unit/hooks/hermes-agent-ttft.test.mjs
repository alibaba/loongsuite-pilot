import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = fileURLToPath(new URL('../../../assets/plugins/hermes-agent/loongsuite-pilot/__init__.py', import.meta.url));
const TTFT = 'gen_ai.response.time_to_first_token';
const temporaryDirectories = [];

// Simulated native contract: Hermes' run_agent.AIAgent streaming method accepts
// on_first_delta as a keyword-only callback and invokes it on an ordinary worker
// thread. These tests exercise that boundary, not a real provider or Hermes run.
const DRIVER = String.raw`
import importlib.util
import json
import pathlib
import sys
import threading
import types

# The test driver is not Hermes' __main__ entrypoint.
sys.modules["__main__"] = types.ModuleType("__main__")

spec = importlib.util.spec_from_file_location("pilot_hermes_plugin", sys.argv[1])
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)

clock = threading.local()
def monotonic_ns():
    value = clock.value
    if isinstance(value, Exception):
        raise value
    return value
plugin.time.perf_counter_ns = monotonic_ns

class Context:
    def __init__(self):
        self.hooks = {}
    def register_hook(self, name, callback):
        self.hooks[name] = callback
ctx = Context()
plugin.register(ctx)

class AIAgent:
    def __init__(self, session_id, api_mode="chat_completions"):
        self.session_id = session_id
        self.api_mode = api_mode
        self.calls = 0
    def _interruptible_streaming_api_call(self, api_kwargs, *, on_first_delta=None):
        self.calls += 1
        if "save_callback" in api_kwargs:
            api_kwargs["save_callback"].append(on_first_delta)
        values, errors = [], []
        def worker():
            try:
                if api_kwargs.get("non_streaming_fallback"):
                    self._disable_streaming = True
                for delta_ns in api_kwargs.get("delta_times", []):
                    clock.value = delta_ns
                    if on_first_delta is not None:
                        values.append(on_first_delta(*api_kwargs.get("args", []), **api_kwargs.get("kwargs", {})))
            except BaseException as error:
                errors.append(error)
        thread = threading.Thread(target=worker)
        thread.start()
        thread.join(timeout=5)
        assert not thread.is_alive(), "stream callback deadlocked"
        if errors:
            raise errors[0]
        return {"values": values, "response": "native-result"}

native_method = AIAgent._interruptible_streaming_api_call
runtime = types.ModuleType("run_agent")
runtime.AIAgent = AIAgent
sys.modules["run_agent"] = runtime

def payload(session, count=1):
    return {"session_id": session, "task_id": "turn-" + session,
            "api_request_id": session + "-api-" + str(count), "api_call_count": count,
            "model": "fixture-model", "provider": "fixture-provider", "platform": "cli"}

def begin(session, start=100, count=1):
    clock.value = start
    ctx.hooks["pre_api_request"](**payload(session, count))

def end(session, count=1, error=False):
    if error:
        ctx.hooks["api_request_error"](**payload(session, count), error={"type": "FixtureError", "message": "fixture"})
    else:
        ctx.hooks["post_api_request"](**payload(session, count), finish_reason="stop", usage={"input_tokens": 2, "output_tokens": 1})

def flush(session):
    ctx.hooks["post_llm_call"](session_id=session, user_message="fixture", assistant_response="done")

extra = {}
`;

function runScenario(scenario, config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-hermes-ttft-'));
  temporaryDirectories.push(root);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  const run = spawnSync('python3', ['-c', `${DRIVER}\n${scenario}\nprint(json.dumps(extra))`, PLUGIN], {
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      HOME: root,
      LOONGSUITE_PILOT_DATA_DIR: root,
      AGENT_DATA_COLLECTION_CONFIG: path.join(root, 'config.json'),
      PYTHONDONTWRITEBYTECODE: '1',
    },
  });
  expect(run.error, run.stderr).toBeUndefined();
  expect(run.status, run.stderr).toBe(0);
  const directory = path.join(root, 'logs', 'hermes-agent');
  const records = fs.existsSync(directory)
    ? fs.readdirSync(directory).filter(name => name.endsWith('.jsonl')).flatMap(name =>
      fs.readFileSync(path.join(directory, name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse))
    : [];
  return {
    responses: records.filter(record => record['event.name'] === 'llm.response'),
    extra: JSON.parse(run.stdout.trim()),
    stderr: run.stderr,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('Hermes TTFT native callback bridge (simulated contract)', () => {
  it('records first delta in nanoseconds across an ordinary thread and preserves every callback invocation', () => {
    const { responses, extra } = runScenario(String.raw`
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
`);
    expect(responses).toHaveLength(1);
    expect(responses[0][TTFT]).toBe(125_000_000);
    expect(extra).toEqual({
      result: { values: ['callback-result', 'callback-result'], response: 'native-result' },
      seen: [[42, 'kept'], [42, 'kept']], calls: 1,
    });
  });

  it('keeps overlapping sessions isolated without context propagation to stream threads', () => {
    const { responses } = runScenario(String.raw`
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
`);
    expect(Object.fromEntries(responses.map(record => [record['gen_ai.session.id'], record[TTFT]])))
      .toEqual({ one: 30, two: 900 });
  });

  it('omits TTFT when the stream emits no first delta', () => {
    const { responses } = runScenario(String.raw`
begin("empty")
AIAgent("empty")._interruptible_streaming_api_call({"delta_times": []})
end("empty")
flush("empty")
`);
    expect(responses).toHaveLength(1);
    expect(responses[0]).not.toHaveProperty(TTFT);
  });

  it('omits the full-response callback used by a non-streaming fallback', () => {
    const { responses, extra } = runScenario(String.raw`
begin("fallback")
agent = AIAgent("fallback")
extra["result"] = agent._interruptible_streaming_api_call(
    {"non_streaming_fallback": True, "delta_times": [180]}, on_first_delta=lambda: "full-response-ready")
extra["disabled_streaming"] = agent._disable_streaming
end("fallback")
flush("fallback")
`);
    expect(extra.disabled_streaming).toBe(true);
    expect(extra.result).toEqual({ values: ['full-response-ready'], response: 'native-result' });
    expect(responses).toHaveLength(1);
    expect(responses[0]).not.toHaveProperty(TTFT);
  });

  it.each([100, 99])('omits non-positive timing when start is 100 and first delta is %s', (firstDelta) => {
    const { responses } = runScenario(String.raw`
begin("invalid-duration", start=100)
AIAgent("invalid-duration")._interruptible_streaming_api_call({"delta_times": [${firstDelta}]})
end("invalid-duration")
flush("invalid-duration")
`);
    expect(responses).toHaveLength(1);
    expect(responses[0]).not.toHaveProperty(TTFT);
  });

  it('records timing when message content capture is disabled', () => {
    const { responses } = runScenario(String.raw`
begin("no-content")
AIAgent("no-content")._interruptible_streaming_api_call({"delta_times": [180]})
end("no-content")
flush("no-content")
`, { agents: { 'hermes-agent': { captureMessageContent: false } } });
    expect(responses).toHaveLength(1);
    expect(responses[0][TTFT]).toBe(80);
    expect(responses[0]['gen_ai.output.messages'][0].parts).toEqual([{ type: 'text', content: '' }]);
  });

  it.each(['old-signature', 'missing-module', 'missing-pre', 'unsupported-mode', 'wrong-session'])
  ('omits TTFT for %s without changing native behavior', (scenario) => {
    const { responses, extra } = runScenario(String.raw`
scenario = ${JSON.stringify(scenario)}
if scenario == "old-signature":
    def old_method(self, api_kwargs):
        return "old-result"
    AIAgent._interruptible_streaming_api_call = old_method
if scenario == "missing-module":
    del sys.modules["run_agent"]
if scenario == "missing-pre":
    # Install the bridge on a different completed request first.
    begin("previous")
    end("previous")
    ctx.hooks["pre_llm_call"](session_id="test", user_message="fixture")
else:
    begin("test")
if scenario == "old-signature":
    extra["result"] = AIAgent("test")._interruptible_streaming_api_call({})
else:
    agent = AIAgent("other" if scenario == "wrong-session" else "test",
                    "responses" if scenario == "unsupported-mode" else "chat_completions")
    extra["result"] = agent._interruptible_streaming_api_call({"delta_times": [180]}, on_first_delta=lambda: "preserved")
end("test")
flush("test")
`);
    expect(responses).toHaveLength(1);
    expect(responses[0]).not.toHaveProperty(TTFT);
    expect(extra.result).toEqual(scenario === 'old-signature'
      ? 'old-result' : { values: ['preserved'], response: 'native-result' });
  });

  it('does not attribute a late callback after error or leak timing into the next request', () => {
    const { responses } = runScenario(String.raw`
begin("retry", count=1)
end("retry", count=1, error=True)
# A stale unconsumed pre context must not update the closed request.
AIAgent("retry")._interruptible_streaming_api_call({"delta_times": [150]})
begin("retry", start=200, count=2)
AIAgent("retry")._interruptible_streaming_api_call({"delta_times": []})
end("retry", count=2)
flush("retry")
`);
    expect(responses).toHaveLength(2);
    for (const response of responses) expect(response).not.toHaveProperty(TTFT);
  });

  it('preserves callback exception identity and can measure a later retry', () => {
    const { responses, extra } = runScenario(String.raw`
begin("retry")
failure = ValueError("native callback failure")
def callback():
    raise failure
try:
    AIAgent("retry")._interruptible_streaming_api_call({"delta_times": [140]}, on_first_delta=callback)
    raise AssertionError("callback exception was swallowed")
except ValueError as caught:
    extra["same_exception"] = caught is failure
end("retry", error=True)
begin("retry", start=200, count=2)
AIAgent("retry")._interruptible_streaming_api_call({"delta_times": [290]})
end("retry", count=2)
flush("retry")
`);
    expect(extra.same_exception).toBe(true);
    expect(responses).toHaveLength(2);
    expect(responses[1][TTFT]).toBe(90);
  });

  it('ignores an already captured callback arriving after request closure', () => {
    const { responses, extra } = runScenario(String.raw`
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
`);
    expect(extra.callback_result).toBe('preserved-after-close');
    expect(responses).toHaveLength(2);
    for (const response of responses) expect(response).not.toHaveProperty(TTFT);
  });

  it('keeps the original callback working when timing collection fails', () => {
    const { responses, extra } = runScenario(String.raw`
begin("clock-failure")
extra["result"] = AIAgent("clock-failure")._interruptible_streaming_api_call(
    {"delta_times": [RuntimeError("clock unavailable")]}, on_first_delta=lambda: "still-called")
end("clock-failure")
flush("clock-failure")
`);
    expect(extra.result).toEqual({ values: ['still-called'], response: 'native-result' });
    expect(responses).toHaveLength(1);
    expect(responses[0]).not.toHaveProperty(TTFT);
  });

  it('installs lazily after module load and does not stack wrappers on repeated registration', () => {
    const { responses, extra } = runScenario(String.raw`
del sys.modules["run_agent"]
begin("early")
end("early")
assert AIAgent._interruptible_streaming_api_call is native_method
sys.modules["run_agent"] = runtime
begin("late")
installed = AIAgent._interruptible_streaming_api_call
assert installed is not native_method
AIAgent("late")._interruptible_streaming_api_call({"delta_times": [150]})
end("late")
flush("late")
plugin.register(ctx)
begin("again", start=200)
extra["same_wrapper"] = installed is AIAgent._interruptible_streaming_api_call
AIAgent("again")._interruptible_streaming_api_call({"delta_times": [280]})
end("again")
flush("again")
`);
    expect(extra.same_wrapper).toBe(true);
    expect(responses.map(response => response[TTFT])).toEqual([50, 80]);
  });

  it('uses the rediscovered plugin request context without wrapping the native method again', () => {
    const { responses, extra } = runScenario(String.raw`
begin("original-plugin")
AIAgent("original-plugin")._interruptible_streaming_api_call({"delta_times": [150]})
end("original-plugin")
flush("original-plugin")
installed = AIAgent._interruptible_streaming_api_call
rediscovered_spec = importlib.util.spec_from_file_location("rediscovered_pilot_plugin", sys.argv[1])
plugin = importlib.util.module_from_spec(rediscovered_spec)
rediscovered_spec.loader.exec_module(plugin)
ctx = Context()
plugin.register(ctx)
begin("rediscovered-plugin", start=200)
extra["same_wrapper"] = installed is AIAgent._interruptible_streaming_api_call
AIAgent("rediscovered-plugin")._interruptible_streaming_api_call({"delta_times": [280]})
end("rediscovered-plugin")
flush("rediscovered-plugin")
`);
    expect(extra.same_wrapper).toBe(true);
    expect(Object.fromEntries(responses.map(record => [record['gen_ai.session.id'], record[TTFT]])))
      .toEqual({ 'original-plugin': 50, 'rediscovered-plugin': 80 });
  });
});
