#!/usr/bin/env node
// Exercise the real dependency separately from its declared Node engine range.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const packageDir = path.resolve(process.argv[2]);
const dependencyDir = path.join(packageDir, 'node_modules/@loongsuite/otel-util-genai');
const metadata = JSON.parse(fs.readFileSync(path.join(dependencyDir, 'package.json'), 'utf8'));
process.env.OTEL_SEMCONV_STABILITY_OPT_IN = 'gen_ai_latest_experimental';
process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = 'SPAN_ONLY';
const { convertEventLogToReadableSpans } = await import(pathToFileURL(path.join(dependencyDir, metadata.main)).href);
const base = {
  trace_id: '1234567890abcdef1234567890abcdef',
  'gen_ai.session.id': 'riscv64-engine-probe',
  'gen_ai.turn.id': 'riscv64-engine-probe:turn-1',
  'gen_ai.step.id': 'riscv64-engine-probe:turn-1:step-1',
  'gen_ai.agent.type': 'qwen-code-cli',
  'gen_ai.provider.name': 'openai',
  'gen_ai.request.model': 'local-probe-model',
};
const result = await convertEventLogToReadableSpans([
  { ...base, 'event.name': 'llm.request', time_unix_nano: '1000000000',
    'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: 'Synthetic probe' }] }] },
  { ...base, 'event.name': 'llm.response', time_unix_nano: '1100000000',
    'gen_ai.response.model': 'local-probe-model', 'gen_ai.response.finish_reasons': ['stop'],
    'gen_ai.usage.input_tokens': 10, 'gen_ai.usage.output_tokens': 2 },
], { strict: false });
assert.deepEqual(result.warnings, []);
const llm = result.spans.find(span => span.attributes['gen_ai.span.kind'] === 'LLM');
assert.ok(llm, 'No LLM span produced by the real GenAI converter');
assert.deepEqual(llm.attributes['gen_ai.response.finish_reasons'], ['stop']);
console.log(JSON.stringify({ node: process.version, arch: process.arch,
  dependency: `${metadata.name}@${metadata.version}`, declared_engines: metadata.engines,
  spans: result.spans.length, status: 'passed',
  scope: 'Synthetic in-process conversion only; does not change the dependency engine contract or test remote OTLP delivery' }));
