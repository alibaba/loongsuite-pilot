import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { convertEventLogToReadableSpans, type EventLogRecord } from '@loongsuite/otel-util-genai';
import { HermesLogInput } from '../../src/inputs/hermes-log/hermes-log-input.js';
import { InputManager } from '../../src/core/input-manager.js';
import { MockFlusher } from '../helpers/mock-flusher.js';
import { MockStateStore } from '../helpers/mock-state-store.js';

// Synthetic official wire formats plus Hermes' normalized post-API Hook contract.
// The original Hermes SDK/HTTP translation is exercised separately by native CLI
// probes against a loopback mock server; this test needs no SDK or credentials.
const shapes = ['legacy-compatible', 'native-compatible', 'native-camel', 'native-snake'];
const scenarios = shapes.flatMap(shape => ['standard', 'long', 'absent'].map(prompt => ({ shape, prompt })));

describe('Hermes Google protocol fixture to LLM span', () => {
  const directories: string[] = [];
  afterEach(async () => {
    for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
  });

  it.each(scenarios)('$shape / $prompt preserves system text, output and fixture usage', async ({ shape, prompt }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-hermes-google-'));
    directories.push(root);
    const fixture = JSON.parse(await fs.readFile('tests/fixtures/hermes-agent/google-protocol.json', 'utf8'));
    const base = fixture.native.request.systemInstruction.parts[0].text as string;
    const content = prompt === 'long' ? 'synthetic identity '.repeat(600) + base + ' 13800138000' : base;
    const expected = prompt === 'absent' ? undefined : [{ type: 'text', content: content.replace('13800138000', '[PHONE_MASKED]') }];
    await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ userId: 'synthetic-google-user' }));
    const driver = await fs.readFile('tests/helpers/hermes-legacy-system-driver.py', 'utf8');
    const scenario = `
fixture = json.loads(${JSON.stringify(JSON.stringify(fixture))})
shape, variant, content = ${JSON.stringify(shape)}, ${JSON.stringify(prompt)}, ${JSON.stringify(content)}
if shape != 'legacy-compatible':
    hermes.__version__, hermes.__release_date__ = ('0.19.0', '2026.7.20') if shape == 'native-compatible' else ('0.22.5', '2026.9.24')
user_input = fixture['compatible']['request']['messages'][-1]['content']
ctx.hooks['pre_llm_call'](session_id='fixture-session', user_message=user_input, conversation_history=[{'role': 'user', 'content': user_input}])
messages = [{'role': 'user', 'content': user_input}]
if variant != 'absent': messages.insert(0, {'role': 'system', 'content': content})
metadata = dict(fields('fixture-session'), provider='gemini', model='gemini-2.5-flash')
if shape == 'legacy-compatible':
    AIAgent()._build_api_kwargs(messages)
    ctx.hooks['pre_api_request'](**metadata)
else:
    short = content[:8000] + f'...[truncated {len(content) - 8000} chars]' if len(content) > 8000 else content
    body = {'messages': [dict(m, content=short) if m['role'] == 'system' else m for m in messages]}
    if shape in ('native-camel', 'native-snake'):
        key = 'system_instruction' if shape == 'native-snake' else 'systemInstruction'
        body = dict(fixture['native']['request'])
        body.pop('systemInstruction', None)
        if variant != 'absent': body[key] = {'parts': [{'text': short}]}
    ctx.hooks['pre_api_request'](**metadata, request={'body': body}, request_messages=messages,
                                 system_prompt=content if shape != 'native-compatible' and variant != 'absent' else None)
# Hermes translates Google's candidate and usageMetadata into these standard
# Hook fields; token values here come only from the synthetic fixture.
if 'compatible' in shape:
    response = fixture['compatible']['response']
    output = response['choices'][0]['message']['content']
    usage = response['usage']
    hook_usage = {'prompt_tokens': usage['prompt_tokens'], 'output_tokens': usage['completion_tokens'], 'total_tokens': usage['total_tokens']}
else:
    response = fixture['native']['response']
    output = response['candidates'][0]['content']['parts'][0]['text']
    usage = response['usageMetadata']
    hook_usage = {'prompt_tokens': usage['promptTokenCount'], 'output_tokens': usage['candidatesTokenCount'], 'total_tokens': usage['totalTokenCount']}
ctx.hooks['post_api_request'](**metadata, finish_reason='stop',
    response={'model': response.get('modelVersion', response.get('model')), 'assistant_message': {'role': 'assistant', 'content': output}},
    usage=hook_usage)
ctx.hooks['post_llm_call'](session_id='fixture-session', user_message=user_input, assistant_response=output)
`;
    const run = spawnSync('python3', ['-c', driver + scenario, path.resolve('assets/plugins/hermes-agent/loongsuite-pilot/__init__.py')], {
      encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: root, AGENT_DATA_COLLECTION_CONFIG: path.join(root, 'config.json'),
        LOONGSUITE_PILOT_USER_ID: '', LOONGSUITE_USER_ID: '', LOONGSUITE_PILOT_SPAN_ATTRIBUTES: '', PYTHONDONTWRITEBYTECODE: '1' },
    });
    expect(run.error, run.stderr).toBeUndefined();
    expect(run.status, run.stderr).toBe(0);

    const input = new HermesLogInput({ stateStore: new MockStateStore() as any, sessionDir: path.join(root, 'logs/hermes-agent'), pollIntervalMs: 60_000 });
    const flusher = new MockFlusher();
    const manager = new InputManager();
    manager.setMaskConfig({ mode: 'all', types: [] });
    manager.setFlusher(flusher);
    manager.registerInput(input);
    await manager.startInput(input.id);
    await manager.stopInput(input.id);
    const events = flusher.batchCalls.flat();
    const request = events.filter(e => e['event.name'] === 'llm.request');
    expect(request).toHaveLength(1);
    expect(request[0]['gen_ai.system_instructions']).toEqual(expected);
    expect(JSON.stringify(events)).not.toContain('13800138000');
    expect(JSON.stringify(request[0]['gen_ai.input.messages_delta'])).not.toContain('Synthetic identity.');

    const oldCapture = process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
    const oldStability = process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = 'SPAN_ONLY';
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN = 'gen_ai_latest_experimental';
    try {
      const converted = await convertEventLogToReadableSpans(events.filter(e => e['event.name'] !== 'agent.input') as EventLogRecord[], { strict: false });
      expect(converted.warnings).toEqual([]);
      const llm = converted.spans.filter(s => s.attributes['gen_ai.span.kind'] === 'LLM');
      expect(llm).toHaveLength(1);
      const attributes = llm[0].attributes;
      const instructions = attributes['gen_ai.system_instructions'];
      expect(instructions === undefined ? undefined : JSON.parse(String(instructions))).toEqual(expected);
      expect(JSON.stringify(attributes['gen_ai.output.messages'])).toContain('GOOGLE_FIXTURE_OK');
      expect(attributes['gen_ai.request.model']).toBe('gemini-2.5-flash');
      expect(attributes['gen_ai.usage.input_tokens']).toBe(120);
      expect(attributes['gen_ai.usage.output_tokens']).toBe(7);
      expect(attributes['gen_ai.usage.total_tokens']).toBe(127);
    } finally {
      if (oldCapture === undefined) delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
      else process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = oldCapture;
      if (oldStability === undefined) delete process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
      else process.env.OTEL_SEMCONV_STABILITY_OPT_IN = oldStability;
    }
  });
});
