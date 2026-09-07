// Real-provider acceptance. Build Pilot first, then set OPENCLAW_E2E_INSTALL to
// an isolated `npm install --prefix <dir> openclaw@2026.3.8` directory and supply
// DASHSCOPE_API_KEY through the environment. No version input to Pilot.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { convertEventLogToReadableSpans } from '@loongsuite/otel-util-genai';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const install = process.env.OPENCLAW_E2E_INSTALL;
assert(install && process.env.DASHSCOPE_API_KEY, 'Set OPENCLAW_E2E_INSTALL and DASHSCOPE_API_KEY');
const packageRoot = path.join(install, 'node_modules/openclaw');
const pkg = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
assert.equal(pkg.version, '2026.3.8');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-openclaw-compat-live-'));
console.log(`Evidence directory: ${root}`);
const dataDir = path.join(root, 'pilot-data');
const state = path.join(root, 'openclaw');
const workspace = path.join(root, 'workspace');
await fs.mkdir(state, { recursive: true });
await fs.mkdir(workspace, { recursive: true });
await fs.mkdir(path.join(dataDir, 'plugins'), { recursive: true });
for (const name of ['openclaw', 'shared']) {
  await fs.cp(path.join(repo, 'assets/plugins', name), path.join(dataDir, 'plugins', name), { recursive: true });
}
await fs.writeFile(path.join(workspace, 'alpha.txt'), 'alpha acceptance sample\n');
await fs.writeFile(path.join(workspace, 'beta.txt'), 'beta acceptance sample\n');
await fs.writeFile(path.join(state, 'openclaw.json'), JSON.stringify({
  gateway: { mode: 'local' },
  agents: { defaults: { workspace, model: { primary: 'dashscope/qwen3-coder-plus' }, skipBootstrap: true } },
  models: { providers: { dashscope: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: '${DASHSCOPE_API_KEY}',
    api: 'openai-completions', models: [{ id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus',
      reasoning: false, input: ['text'], contextWindow: 1000000, maxTokens: 4096 }],
  } } },
}), { mode: 0o600 });
await fs.writeFile(path.join(dataDir, 'config.json'), JSON.stringify({
  userId: 'pilot-openclaw-compat-e2e', agents: { openclaw: { enabled: true, captureMessageContent: true } },
}), { mode: 0o600 });
const env = { ...process.env, PATH: `${path.join(install, 'node_modules/.bin')}${path.delimiter}${process.env.PATH}`,
  OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: path.join(state, 'openclaw.json'),
  LOONGSUITE_PILOT_DATA_DIR: dataDir, LOONGSUITE_USER_ID: 'pilot-openclaw-compat-e2e',
  OTEL_SEMCONV_STABILITY_OPT_IN: 'gen_ai_latest_experimental',
  OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'SPAN_ONLY',
};
for (const key of ['NODE_OPTIONS', 'OPENCLAW_CLI_PATH', 'OPENCLAW_BUNDLE_ROOT', 'OPENCLAW_SERVICE_VERSION', 'OPENCLAW_BUNDLED_VERSION']) delete env[key];

async function run(label, args, timeout = 180_000) {
  const output = [];
  const child = spawn(process.execPath, args, { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const pipe of [child.stdout, child.stderr]) pipe.on('data', chunk => output.push(chunk));
  const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  clearTimeout(timer);
  await fs.writeFile(path.join(root, `${label}.log`), Buffer.concat(output), { mode: 0o600 });
  assert.equal(code, 0, `${label} failed, inspect ${root}/${label}.log`);
}
await run('inject', [path.join(repo, 'dist/inject-hooks.cjs'), '--agents=openclaw', `--pilot-dir=${repo}`, `--data-dir=${dataDir}`]);
const config = JSON.parse(await fs.readFile(env.OPENCLAW_CONFIG_PATH, 'utf8'));
assert.equal(config.plugins.entries['loongsuite-pilot-openclaw'].enabled, true);
assert.equal(config.plugins.entries['loongsuite-pilot-openclaw'].hooks?.allowConversationAccess, undefined);
await run('config-validation', [path.join(packageRoot, 'openclaw.mjs'), 'config', 'validate']);
const scenarios = [
  ['text', 'Respond with exactly: OPENCLAW_COMPAT_TEXT_OK. Do not use tools.'],
  ['tools', 'Use the read tool to read alpha.txt and beta.txt in this workspace, then use read to read missing-acceptance.txt (expected to be missing). Finally state the two file contents and acknowledge the missing file.'],
  ['privacy', 'Use the read tool to read alpha.txt then respond with PRIVACY_ACCEPTANCE_MARKER.'],
];
const reports = [];
for (const [label, prompt] of scenarios) {
  if (label === 'privacy') {
    await fs.writeFile(path.join(dataDir, 'config.json'), JSON.stringify({ agents: { openclaw: { captureMessageContent: false } } }));
  }
  const sessionId = `pilot-compat-${label}-${Date.now()}`;
  await run(label, [path.join(packageRoot, 'openclaw.mjs'), 'agent', '--local', '--session-id', sessionId,
    '--message', prompt, '--thinking', 'off', '--timeout', '120', '--json']);
  const logDir = path.join(dataDir, 'logs/openclaw');
  const records = (await Promise.all((await fs.readdir(logDir)).filter(n => n.endsWith('.jsonl')).map(async n =>
    (await fs.readFile(path.join(logDir, n), 'utf8')).split('\n').filter(Boolean).map(JSON.parse))))
    .flat().filter(r => r['gen_ai.session.id'] === sessionId && !['session_start', 'session_end'].includes(r['agent.openclaw.hook']));
  const requests = records.filter(r => r['event.name'] === 'llm.request');
  const responses = records.filter(r => r['event.name'] === 'llm.response');
  assert(requests.length > 0, `${label}: no model calls observed`);
  assert.equal(requests.length, responses.length);
  assert.equal(new Set(records.map(r => r.trace_id)).size, 1);
  assert(records.some(r => r['agent.openclaw.hook'] === 'llm_output'), 'missing terminal aggregate');
  assert(responses.every(r => r['gen_ai.usage.output_tokens'] > 0));
  assert(responses.every(r => r['agent.openclaw.timing.inferred'] === true));
  const source = (await fs.readFile(path.join(state, 'agents/main/sessions', `${sessionId}.jsonl`), 'utf8'))
    .split('\n').filter(Boolean).map(JSON.parse).filter(r => r.type === 'message' && r.message?.role === 'assistant').map(r => r.message);
  assert.equal(source.length, responses.length, 'native transcript model count');
  for (let i = 0; i < source.length; i++) {
    assert.equal(responses[i]['gen_ai.usage.input_tokens'], source[i].usage.input + source[i].usage.cacheRead + source[i].usage.cacheWrite);
    assert.equal(responses[i]['gen_ai.usage.output_tokens'], source[i].usage.output);
  }
  const tools = records.filter(r => r['event.name'] === 'tool.call');
  if (label === 'tools') {
    assert(tools.length >= 3, 'tool scenario did not execute expected reads');
    assert(records.some(r => r['event.name'] === 'tool.result' && r['error.type']), 'tool failure not represented');
  }
  if (label === 'privacy') {
    const text = JSON.stringify(records);
    for (const sentinel of ['PRIVACY_ACCEPTANCE_MARKER', 'alpha acceptance sample']) assert(!text.includes(sentinel));
    for (const record of records) for (const field of ['gen_ai.input.messages', 'gen_ai.input.messages_delta', 'gen_ai.output.messages', 'gen_ai.tool.call.arguments', 'gen_ai.tool.call.result', 'error.message']) {
      assert.equal(record[field], undefined, `content-off leaked ${field}`);
    }
  }
  process.env.OTEL_SEMCONV_STABILITY_OPT_IN = env.OTEL_SEMCONV_STABILITY_OPT_IN;
  process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
  const converted = await convertEventLogToReadableSpans(records, { strict: false });
  assert.deepEqual(converted.warnings, []);
  const counts = {};
  for (const span of converted.spans) {
    const kind = span.attributes['gen_ai.span.kind']; counts[kind] = (counts[kind] || 0) + 1;
    if (['LLM', 'TOOL'].includes(kind)) assert(span.duration[0] * 1e9 + span.duration[1] > 0, 'non-positive duration');
  }
  assert.equal(counts.ENTRY, 1); assert.equal(counts.AGENT, 1);
  assert.equal(counts.LLM, responses.length); assert.equal(counts.TOOL || 0, tools.length);
  const report = { scenario: label, sessionId, traceId: records[0].trace_id, events: records.length,
    spans: counts, sourceAssistantMessages: source.length, nativeTokenParity: true, warnings: converted.warnings };
  reports.push(report);
  console.log(JSON.stringify(report));
}
await fs.writeFile(path.join(root, 'result.json'), JSON.stringify({ openclaw: pkg.version, node: process.version, reports }, null, 2));
