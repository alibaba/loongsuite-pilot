// Offline comparison of independently queried SLS JSONL with Gateway evidence.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { assertOpenClawEvidence, assertContentPresent } from './openclaw-assertions.mjs';

const [root, backendFile] = process.argv.slice(2);
assert(root && backendFile, 'Usage: node openclaw-backend.mjs <evidence-directory> <SLS-JSONL>');
const read = async p => JSON.parse(await fs.readFile(p, 'utf8'));
const rows = async p => (await fs.readFile(p, 'utf8')).split('\n').filter(l => l.trim()).map(JSON.parse);
async function directory(p) {
  return (await Promise.all((await fs.readdir(p)).sort().filter(n => n.endsWith('.jsonl')).map(n => rows(path.join(p, n))))).flat();
}
const report = await read(path.join(root, 'result.json'));
assert.equal(report.verdict, 'PASS', 'Local acceptance must pass first');
const local = await directory(path.join(root, 'pilot-logs/otlp-debug'));
const events = await directory(path.join(root, 'pilot-logs/output'));
const nativeMessages = (await directory(path.join(root, 'native-sessions'))).filter(r => r.type === 'message').map(r => r.message);
const remote = await rows(backendFile);
const id = s => `${s.traceId}/${s.spanId}`;
assert(remote.length > 0, 'Empty backend evidence');
assert.equal(new Set(remote.map(id)).size, remote.length, 'Duplicate backend spans');
assert.deepEqual(remote.map(id).sort(), local.map(id).sort(), 'Local/backend span ID sets differ');
const spans = remote.map(row => {
  assert.equal(row.serviceName, report.service, 'Backend service mismatch');
  const attributes = JSON.parse(row.attributes), resource = JSON.parse(row.resources);
  for (const key of Object.keys(attributes)) if (key.startsWith('gen_ai.usage.')) attributes[key] = Number(attributes[key]);
  const original = local.find(s => id(s) === id(row));
  assert.equal(row.parentSpanId, original.parentSpanId, 'Backend parent changed');
  assert.equal(String(row.startTime), original.startTimeUnixNano, 'Backend start changed');
  assert.equal(String(row.endTime), original.endTimeUnixNano, 'Backend end changed');
  for (const key of ['gen_ai.span.kind', 'gen_ai.turn.id', 'gen_ai.session.id', 'gen_ai.user.id',
    'gen_ai.tool.call.id', 'gen_ai.response.id', 'gen_ai.agent.name', 'agent.openclaw.user.id.source',
    ...Object.keys(original.attributes).filter(k => k.startsWith('gen_ai.usage.'))]) {
    assert.deepEqual(attributes[key], original.attributes[key], `Backend attribute changed: ${key}`);
  }
  return { traceId: row.traceId, spanId: row.spanId, parentSpanId: row.parentSpanId,
    startTimeUnixNano: row.startTime, endTimeUnixNano: row.endTime, attributes, resource, status: { code: Number(row.statusCode) } };
});
const validation = assertOpenClawEvidence({ events, spans, nativeMessages, provider: report.provider,
  model: report.model, service: report.service, workerName: report.workerName, turns: 4,
  expectedToolErrorTraceIds: report.legacyConfigTraceIds });
// The random marker is retained only in this private synthetic workspace.
const marker = await fs.readFile(path.join(root, 'workspace/legacy-config.txt'), 'utf8');
assertContentPresent(remote.filter(s => report.legacyConfigTraceIds.includes(s.traceId)).map(s => ({ ...s, attributes: JSON.parse(s.attributes) })), [marker]);
const result = { verdict: 'PASS', service: report.service, backendSpans: remote.length, ...validation };
await fs.writeFile(path.join(root, 'backend-validation.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
console.log(JSON.stringify(result));
