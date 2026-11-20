// Synthetic records matching upstream Qwen v0.21.1's foreground writer.
// This is a contract fixture, NOT captured customer telemetry or a live E2E.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const processor = fileURLToPath(new URL('../../../../assets/hooks/qwen-code-cli-hook-processor.mjs', import.meta.url));
export const ts = n => new Date(Date.UTC(2026, 8, 22, 4) + n * 1000).toISOString();
export function fixture(directory) {
  const sessionId = 'synthetic-session';
  const project = path.join(directory, 'project');
  const transcript = path.join(project, 'chats', `${sessionId}.jsonl`);
  const children = path.join(project, 'subagents', sessionId);
  const data = path.join(directory, 'pilot');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.mkdirSync(children, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  let seq = 0;
  const record = (type, time, parts, fields = {}) => ({
    type, uuid: `record-${++seq}`, sessionId, timestamp: ts(time),
    message: { role: type === 'assistant' ? 'model' : 'user', parts }, ...fields,
  });
  const user = (t, text) => record('user', t, [{ text }]);
  const round = (t, text, tokens = 10) => record('assistant', t, [{ text }], {
    agentRunId: 'run-1', agentRound: t,
    usageMetadata: { promptTokenCount: tokens, candidatesTokenCount: 2, totalTokenCount: tokens + 2 },
  });
  const call = (t, id, name = 'agent') => record('assistant', t, [{ functionCall: { id, name, args: { prompt: 'SENSITIVE_TASK' } } }]);
  const result = (t, id) => record('tool_result', t, [{ functionResponse: { id, name: 'agent', response: { output: 'SENSITIVE_RESULT' } } }], { toolCallResult: { callId: id, durationMs: 100 } });
  const main = [user(0, 'SENSITIVE_MAIN'), call(1, 'root-call'), result(10, 'root-call'), round(11, 'Main finished', 20)];
  main[1].model = 'qwen3-test';
  main[1].usageMetadata = { promptTokenCount: 30, candidatesTokenCount: 3, totalTokenCount: 33 };
  main[3].model = 'qwen3-test';
  const child = [user(2, 'SENSITIVE_CHILD'), round(3, 'Plan', 10), call(3.1, 'nested-call'), result(8, 'nested-call'), round(9, 'Child finished', 12)];
  const grandchild = [user(4, 'SENSITIVE_GRANDCHILD'), round(5, 'Grandchild finished', 5)];
  function write(filename, rows) { fs.writeFileSync(filename, rows.map(r => JSON.stringify(r)).join('\n') + '\n'); }
  function writeChild(id, parent, tool, rows, overrides = {}) {
    const meta = { agentId: id, agentType: id, parentSessionId: sessionId, parentAgentId: parent,
      toolUseId: tool, isBackgrounded: false, status: 'completed', persistedCliFlags: { model: 'qwen3-test' }, ...overrides };
    fs.writeFileSync(path.join(children, `agent-${id}.meta.json`), JSON.stringify(meta));
    write(path.join(children, `agent-${id}.jsonl`), rows.map(r => ({ ...r, agentId: id, isSidechain: true })));
    return meta;
  }
  write(transcript, main);
  writeChild('child', null, 'root-call', child);
  writeChild('grandchild', 'child', 'nested-call', grandchild);
  function run(extra = {}, extraEnv = {}) {
    const env = { ...process.env, LOONGSUITE_PILOT_DATA_DIR: data };
    for (const k of ['LOONGSUITE_PILOT_SPAN_ATTRIBUTES','AGENTTEAMS_WORKER_NAME','AGENTTEAMS_INSTANCE_ID','AGENTTEAMS_TOKEN']) delete env[k];
    Object.assign(env, extraEnv);
    const r = spawnSync(process.execPath, [processor, 'stop'], { env, encoding: 'utf8', timeout: 15000,
      input: JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd: project, ...extra }) });
    if (r.status !== 0 || r.stdout.trim() !== '{}') throw new Error(`Hook failed: ${r.error || r.stderr}`);
    const logs = path.join(data, 'logs/qwen-code-cli');
    return fs.existsSync(logs) ? fs.readdirSync(logs).filter(n => n.endsWith('.jsonl')).flatMap(n =>
      fs.readFileSync(path.join(logs, n), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)) : [];
  }
  return { data, transcript, children, sessionId, main, child, grandchild, user, round, call, result, write, writeChild, run };
}
