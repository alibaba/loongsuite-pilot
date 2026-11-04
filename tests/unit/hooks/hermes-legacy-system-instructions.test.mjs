import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = fileURLToPath(new URL('../../../assets/plugins/hermes-agent/loongsuite-pilot/__init__.py', import.meta.url));
const temporaryDirectories = [];

// Simulates the fixed v2026.4.16 builder -> synchronous metadata-only hook
// boundary. Real CLI/provider coverage is performed separately.
const DRIVER = fs.readFileSync(new URL('../../helpers/hermes-legacy-system-driver.py', import.meta.url), 'utf8');

function runScenario(scenario) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-hermes-legacy-system-'));
  temporaryDirectories.push(root);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ userId: 'fixture-user' }));
  const run = spawnSync('python3', ['-c', `${DRIVER}\n${scenario}\nprint(json.dumps(extra))`, PLUGIN], {
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      LOONGSUITE_PILOT_DATA_DIR: root,
      AGENT_DATA_COLLECTION_CONFIG: path.join(root, 'config.json'),
      PYTHONDONTWRITEBYTECODE: '1',
    },
  });
  expect(run.error, run.stderr).toBeUndefined();
  expect(run.status, run.stderr).toBe(0);
  const directory = path.join(root, 'logs', 'hermes-agent');
  const records = fs.existsSync(directory) ? fs.readdirSync(directory).filter(n => n.endsWith('.jsonl'))
    .flatMap(n => fs.readFileSync(path.join(directory, n), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)) : [];
  return { requests: records.filter(r => r['event.name'] === 'llm.request'), records, extra: JSON.parse(run.stdout.trim()) };
}

const instructions = request => request['gen_ai.system_instructions'];
const text = content => [{ type: 'text', content }];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('Hermes 4.16 system instructions compatibility', () => {
  it('captures the first request and changing per-call instructions without changing native requests or business inputs', () => {
    const { requests, extra } = runScenario(String.raw`
begin()
agent = AIAgent()
first = request(agent, 'cached identity + ephemeral rule one')
second = request(agent, 'cached identity + ephemeral rule two', 2)
extra['native_calls'] = agent.calls
extra['native_content'] = [first['messages'][0]['content'], second['messages'][0]['content']]
finish()
`);
    expect(extra).toEqual({ native_calls: 2, native_content: ['cached identity + ephemeral rule one', 'cached identity + ephemeral rule two'] });
    expect(requests.map(instructions)).toEqual([text(extra.native_content[0]), text(extra.native_content[1])]);
    expect(new Set(requests.map(r => r['gen_ai.input.messages_hash'])).size).toBe(1);
    expect(requests.every(r => r['gen_ai.input.messages_delta'].every(m => m.role === 'user'))).toBe(true);
  });

  it('prefers native payloads, including blank or malformed ones, and consumes the fallback once', () => {
    const { requests } = runScenario(String.raw`
begin()
agent = AIAgent()
request(agent, 'must not replace native', request={'body': {'system': 'native instruction'}})
request(agent, 'must not replace blank', 2, request={})
request(agent, 'must not replace malformed', 3, request=None)
observe(count=4)
finish()
`);
    expect(requests.map(instructions)).toEqual([text('native instruction'), undefined, undefined, undefined]);
  });

  it('captures developer and system text parts while skipping blank instructions', () => {
    const { requests } = runScenario(String.raw`
begin()
agent = AIAgent()
agent._build_api_kwargs([{'role': 'developer', 'content': [{'type': 'text', 'text': 'developer rule'}]},
                        {'role': 'system', 'content': 'system rule'},
                        {'role': 'system', 'content': '  '},
                        {'role': 'user', 'content': 'fixture input'}])
observe()
finish()
`);
    expect(requests.map(instructions)).toEqual([[
      { type: 'text', content: 'developer rule' }, { type: 'text', content: 'system rule' },
    ]]);
  });

  it.each([
    ['0.16.0', '2026.6.5'], ['0.19.0', '2026.7.20'], ['0.22.5', '2026.9.24'], ['0.10.0', '2026.4.17'],
  ])('keeps %s / %s on native collection', (version, releaseDate) => {
    const { requests, extra } = runScenario(`
hermes.__version__, hermes.__release_date__ = ${JSON.stringify(version)}, ${JSON.stringify(releaseDate)}
begin()
extra['unwrapped'] = AIAgent._build_api_kwargs is native
request(AIAgent(), 'not observed', request={'body': {'system': 'native instruction'}})
finish()
`);
    expect(extra.unwrapped).toBe(true);
    expect(requests.map(instructions)).toEqual([text('native instruction')]);
  });

  it.each(['messages', 'system', 'instructions', 'systemInstruction'])(
    'recovers an explicitly truncated native %s prompt from the same Hook without wrapping modern Hermes', shape => {
    const { requests, extra } = runScenario(`
hermes.__version__, hermes.__release_date__ = '0.22.5', '2026.9.24'
begin()
prompt = 'native identity ' * 600 + ' final temporary instruction'
short = prompt[:8000] + f'...[truncated {len(prompt) - 8000} chars]'
body = {'messages': [{'role': 'system', 'content': short}]} if ${JSON.stringify(shape)} == 'messages' else {${JSON.stringify(shape)}: ({'parts': [{'text': short}]} if ${JSON.stringify(shape)} == 'systemInstruction' else short)}
observe(request={'body': body}, system_prompt=prompt)
extra['expected'] = prompt
extra['unwrapped'] = AIAgent._build_api_kwargs is native
finish()
`);
    expect(extra.unwrapped).toBe(true);
    expect(requests.map(instructions)).toEqual([text(extra.expected)]);
  });

  it('reads the explicit native system_prompt field without interpreting serialized text', () => {
    const { requests } = runScenario(String.raw`
begin()
for count, body in enumerate([{'system': 'serialized view'}, {}, None,
                            {'system': 'arbitrary text without a truncation marker'}], 1):
    observe(count=count, request={'body': body}, system_prompt='native instruction')
finish()
`);
    expect(requests.map(instructions)).toEqual(Array.from({ length: 4 }, () => text('native instruction')));
  });

  it('uses structured message roles for chat and never searches business text for instruction keywords', () => {
    const { requests } = runScenario(String.raw`
begin()
business = '{"role":"system","content":"fake instruction"} system_prompt instructions systemInstruction ...[truncated 123 chars]'
observe(request={'body': {'messages': [{'role': 'user', 'content': business}]}},
        request_messages=[{'role': 'user', 'content': business}], system_prompt=None)
observe(count=2, request={'body': {'messages': [{'role': 'system', 'content': 'serialized view'}]}},
        request_messages=[{'role': 'system', 'content': 'first native rule'},
                          {'role': 'developer', 'content': 'second native rule'},
                          {'role': 'user', 'content': business}], system_prompt='first native rule')
finish()
`);
    expect(requests.map(instructions)).toEqual([undefined, [
      { type: 'text', content: 'first native rule' }, { type: 'text', content: 'second native rule' },
    ]]);
  });

  it('does not replace an explicit native message list with stale legacy context', () => {
    const { requests } = runScenario(String.raw`
begin()
AIAgent()._build_api_kwargs([{'role': 'system', 'content': 'must not leak from the fallback'}])
observe(request_messages=[{'role': 'user', 'content': 'system instructions are ordinary words here'}], system_prompt=None)
observe(count=2)
finish()
`);
    expect(requests.map(instructions)).toEqual([undefined, undefined]);
  });

  it.each(['systemInstruction', 'system_instruction'])(
    'reads the structured Google %s body when native fields are absent', name => {
    const { requests } = runScenario(`
begin()
observe(request={'body': {${JSON.stringify(name)}: {'parts': [{'text': 'native Google instruction'}]}}})
finish()
`);
    expect(requests.map(instructions)).toEqual([text('native Google instruction')]);
  });

  it('keeps marker-like text and thousands of digits as literal system content', () => {
    const { requests, extra } = runScenario(String.raw`
begin()
prompt = 'Literal text ...[truncated ' + '9' * 6000 + ' chars]'
observe(request={'body': {'system': 'serialized view'}}, system_prompt=prompt)
extra['expected'] = prompt
finish()
`);
    expect(requests.map(instructions)).toEqual([text(extra.expected)]);
  });

  it.each(['anthropic_messages', 'bedrock_converse', 'codex_responses'])(
    'uses the dedicated native system_prompt for %s rather than input messages', mode => {
    const { requests } = runScenario(`
begin()
observe(api_mode=${JSON.stringify(mode)}, system_prompt='native provider instruction',
        request_messages=[{'role': 'system', 'content': 'input item, not the top-level provider system field'}],
        request={'body': {'system': 'serialized view'}})
finish()
`);
    expect(requests.map(instructions)).toEqual([text('native provider instruction')]);
  });

  it.each([['0.19.0', '2026.7.20'], ['0.22.5', '2026.9.24']])(
    'uses the native request_messages field for long chat/Gemini instructions on %s', (version, releaseDate) => {
    const { requests, extra } = runScenario(`
hermes.__version__, hermes.__release_date__ = ${JSON.stringify(version)}, ${JSON.stringify(releaseDate)}
begin()
prompt = 'native identity ' * 600 + ' final temporary instruction'
short = prompt[:8000] + f'...[truncated {len(prompt) - 8000} chars]'
observe(request={'body': {'messages': [{'role': 'system', 'content': short}]}}, request_messages=[{'role': 'system', 'content': prompt}, {'role': 'user', 'content': 'must stay in business input'}])
extra['expected'] = prompt
extra['unwrapped'] = AIAgent._build_api_kwargs is native
finish()
`);
    expect(extra.unwrapped).toBe(true);
    expect(requests.map(instructions)).toEqual([text(extra.expected)]);
  });

  it('recovers native truncated previews and text blocks within the existing content bound', () => {
    const { requests, extra } = runScenario(String.raw`
begin()
observe(request={'_truncated': True, 'original_type': 'dict', 'preview': 'native capped body'}, system_prompt='full native instruction')
observe(count=2, request={'body': {'system': [{'type': 'text', 'text': 'stable'}, {'type': 'text', 'text': 'prefix...[truncated 10 chars]'}]}}, system_prompt=[{'type': 'text', 'text': 'stable'}, {'type': 'text', 'text': 'prefix0123456789'}])
prompt = 'x' * 40000
observe(count=3, request={'body': {'system': 'x' * 8000 + '...[truncated 32000 chars]'}}, system_prompt=prompt)
extra['bounded'] = plugin._truncate(prompt)
finish()
`);
    expect(requests.map(instructions)).toEqual([
      text('full native instruction'),
      [{ type: 'text', content: 'stable' }, { type: 'text', content: 'prefix0123456789' }],
      text(extra.bounded),
    ]);
    expect(extra.bounded.length).toBeLessThan(33_000);
  });

  it('rejects an incompatible builder signature without affecting host collection', () => {
    const { requests, extra } = runScenario(String.raw`
def incompatible(self, api_messages, *, mode=None):
    return {'messages': api_messages}
AIAgent._build_api_kwargs = incompatible
begin()
extra['unwrapped'] = AIAgent._build_api_kwargs is incompatible
agent = AIAgent()
agent._build_api_kwargs([{'role': 'system', 'content': 'unsupported builder'}])
observe()
finish()
`);
    expect(extra.unwrapped).toBe(true);
    expect(requests.map(instructions)).toEqual([undefined]);
  });

  it('preserves native exceptions and never reuses a failed build or an expired request', () => {
    const { requests, extra } = runScenario(String.raw`
begin()
agent = AIAgent()
agent._build_api_kwargs([{'role': 'system', 'content': 'stale instruction'}])
native_error = ValueError('native builder failed')
try:
    agent._build_api_kwargs(native_error)
except ValueError as error:
    extra['same_error'] = error is native_error
observe()
plugin.time.monotonic_ns = lambda: 10
agent._build_api_kwargs([{'role': 'system', 'content': 'expired instruction'}])
plugin.time.monotonic_ns = lambda: 5_000_000_011
observe(count=2)
finish()
`);
    expect(extra.same_error).toBe(true);
    expect(requests.map(instructions)).toEqual([undefined, undefined]);
  });

  it.each(['chat_completions', 'codex_responses'])('refreshes the %s observer after reload without stacking wrappers', mode => {
    const { requests, extra } = runScenario(`
begin()
agent = AIAgent(api_mode=${JSON.stringify(mode)})
request(agent, 'before reload')
finish()
method = '_preflight_codex_api_kwargs' if agent.api_mode == 'codex_responses' else '_build_api_kwargs'
wrapped = getattr(AIAgent, method)
plugin, ctx = load_plugin()
begin('resumed-session')
extra['same_wrapper'] = getattr(AIAgent, method) is wrapped
agent = AIAgent('resumed-session', api_mode=${JSON.stringify(mode)})
request(agent, 'after reload')
extra['native_calls'] = agent.calls
finish('resumed-session')
`);
    expect(extra).toEqual({ same_wrapper: true, native_calls: 1 });
    expect(requests.map(instructions)).toEqual([text('before reload'), text('after reload')]);
  });

  it('keeps two interleaved request builders separate across threads and sessions', () => {
    const { requests } = runScenario(String.raw`
barrier = threading.Barrier(2)
def worker(session):
    begin(session)
    agent = AIAgent(session)
    agent._build_api_kwargs([{'role': 'system', 'content': 'rule-' + session}])
    barrier.wait(timeout=3)
    observe(session)
    finish(session)
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    list(pool.map(worker, ['session-a', 'session-b']))
`);
    expect(requests).toHaveLength(2);
    for (const r of requests) expect(instructions(r)).toEqual(text(`rule-${r['gen_ai.session.id']}`));
  });

  it('rejects a mismatched session and clears pending instructions on cancellation', () => {
    const { requests } = runScenario(String.raw`
begin()
agent = AIAgent()
agent._build_api_kwargs([{'role': 'system', 'content': 'wrong session'}])
observe('another-session')
observe()
agent._build_api_kwargs([{'role': 'system', 'content': 'cancelled request'}])
ctx.hooks['on_session_end'](session_id='fixture-session', interrupted=True)
observe(count=2)
finish()
`);
    expect(requests.map(instructions)).toEqual([undefined, undefined, undefined]);
  });

  it.each(['chat_completions', 'anthropic_messages', 'bedrock_converse', 'codex_responses'])(
    'captures assembled %s instructions, including ASCII recovery', mode => {
    const { requests, extra } = runScenario(`
begin()
agent = AIAgent(api_mode=${JSON.stringify(mode)})
request(agent, 'cached identity + 临时规则', 1)
agent._force_ascii_payload = True
request(agent, 'cached identity + 临时规则', 2)
request(agent, '纯中文', 3)
extra['native_calls'] = agent.calls
extra['preflight_calls'] = agent.preflight_calls
finish()
`);
    expect(requests.map(instructions)).toEqual([
      text('cached identity + 临时规则'),
      text(mode === 'codex_responses' ? 'cached identity +' : 'cached identity + '),
      mode === 'codex_responses' ? text('fixture default identity') : undefined,
    ]);
    expect(extra).toEqual({ native_calls: 3, preflight_calls: mode === 'codex_responses' ? 3 : 0 });
  });

  it.each([
    ['  final rule  ', 'final rule'], ['   ', 'fixture default identity'],
    [null, 'fixture default identity'], [42, '42'],
  ])('observes Responses instructions after native normalization of %j', (override, expected) => {
    const { requests, extra } = runScenario(`
begin()
agent = AIAgent(api_mode='codex_responses')
agent.request_overrides = json.loads(${JSON.stringify(JSON.stringify({ instructions: override }))})
body = request(agent, 'replaced rule')
extra['final_instructions'] = body['instructions']
extra['preflight_calls'] = agent.preflight_calls
finish()
`);
    expect(instructions(requests[0])).toEqual(text(expected));
    expect(extra).toEqual({ final_instructions: expected, preflight_calls: 1 });
  });

  it('does not capture Responses before preflight or reuse a failed preflight', () => {
    const { requests, extra } = runScenario(String.raw`
begin()
agent = AIAgent(api_mode='codex_responses')
agent._build_api_kwargs([{'role': 'system', 'content': 'before preflight'}])
observe(api_mode=agent.api_mode)
agent._preflight_codex_api_kwargs({'instructions': 'not reused after failure'})
native_error = ValueError('native preflight failed')
try:
    agent._preflight_codex_api_kwargs(native_error)
except ValueError as error:
    extra['same_error'] = error is native_error
observe(count=2, api_mode=agent.api_mode)
finish()
`);
    expect(extra.same_error).toBe(true);
    expect(requests.map(instructions)).toEqual([undefined, undefined]);
  });

  it('isolates protocol switches within the same session and rejects a mismatched hook mode', () => {
    const { requests } = runScenario(String.raw`
begin()
agent = AIAgent(api_mode='anthropic_messages')
agent._build_api_kwargs([{'role': 'system', 'content': 'wrong protocol'}])
observe(api_mode='bedrock_converse')
request(agent, 'anthropic rule', 2)
agent.api_mode = 'codex_responses'
request(agent, 'responses rule', 3)
agent.api_mode = 'chat_completions'
request(agent, 'chat rule', 4)
finish()
`);
    expect(requests.map(instructions)).toEqual([
      undefined, text('anthropic rule'), text('responses rule'), text('chat rule'),
    ]);
  });

  it('rejects an incompatible Responses preflight without reporting its initial builder value', () => {
    const { requests, extra } = runScenario(String.raw`
def incompatible(self, api_kwargs, allow_stream=False):
    return dict(api_kwargs, instructions='unsupported preflight')
AIAgent._preflight_codex_api_kwargs = incompatible
begin()
extra['unwrapped'] = AIAgent._preflight_codex_api_kwargs is incompatible
agent = AIAgent(api_mode='codex_responses')
body = agent._build_api_kwargs([{'role': 'system', 'content': 'must not report'}])
agent._preflight_codex_api_kwargs(body)
observe(api_mode=agent.api_mode)
finish()
`);
    expect(extra.unwrapped).toBe(true);
    expect(requests.map(instructions)).toEqual([undefined]);
  });

  it('omits unsupported legacy API modes', () => {
    const { requests } = runScenario(`
begin()
agent = AIAgent(api_mode='unsupported')
request(agent, 'Unicode 系统指令')
finish()
`);
    expect(requests.map(instructions)).toEqual([undefined]);
  });

  it('retains only bounded system text, with no user messages or tool definitions from the builder', () => {
    const { requests, extra } = runScenario(String.raw`
begin()
agent = AIAgent()
body = agent._build_api_kwargs([{'role': 'system', 'content': 'x' * 100000},
                              {'role': 'user', 'content': 'builder-only-user-marker'}])
body['tools'] = [{'type': 'function', 'function': {'name': 'builder-only-tool'}}]
observe()
finish()
extra['native_system_length'] = len(body['messages'][0]['content'])
`);
    expect(extra.native_system_length).toBe(100000);
    expect(instructions(requests[0])[0].content.length).toBeLessThan(33_000);
    expect(requests[0]).not.toHaveProperty('gen_ai.tool.definitions');
    expect(JSON.stringify(requests)).not.toContain('builder-only-user-marker');
  });

  it('applies ASCII recovery before truncation without changing the native rewrite', () => {
    const { requests, extra } = runScenario(String.raw`
begin()
agent = AIAgent(api_mode='anthropic_messages')
agent._force_ascii_payload = True
body = request(agent, '中' * 100000 + ' final ASCII rule')
extra['native_system'] = body['system']
finish()
`);
    expect(extra.native_system).toBe(' final ASCII rule');
    expect(instructions(requests[0])).toEqual(text(extra.native_system));
  });

  it('leaves native results intact when observing the body fails', () => {
    const { requests, extra } = runScenario(String.raw`
begin()
def broken_extract(request): raise RuntimeError('observer unavailable')
AIAgent._build_api_kwargs._pilot_legacy_system_extract = broken_extract
agent = AIAgent()
request(agent, 'normal host request')
extra['native_calls'] = agent.calls
finish()
`);
    expect(extra.native_calls).toBe(1);
    expect(requests.map(instructions)).toEqual([undefined]);
  });

  it('preserves normal request events when the compatibility context or clock is unavailable', () => {
    const { requests } = runScenario(String.raw`
begin()
agent = AIAgent()
agent._build_api_kwargs([{'role': 'system', 'content': 'not reused after clock failure'}])
def broken_clock(): raise RuntimeError('clock unavailable')
plugin.time.monotonic_ns = broken_clock
observe()
class BrokenContext:
    def get(self): raise RuntimeError('context unavailable')
    def set(self, value): raise RuntimeError('context unavailable')
plugin._LEGACY_SYSTEM_INSTRUCTIONS = BrokenContext()
request(agent, 'not observed', 2, request={'body': {'system': 'native instruction'}})
finish()
`);
    expect(requests.map(instructions)).toEqual([undefined, text('native instruction')]);
  });
});
