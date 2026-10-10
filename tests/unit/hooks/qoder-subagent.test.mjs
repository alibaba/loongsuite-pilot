import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectSubagentRecordsForTurn } from '../../../assets/hooks/qoder-hook-processor.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROCESSOR = path.resolve(__dirname, '../../../assets/hooks/qoder-hook-processor.mjs');
const FIXTURES = path.resolve(__dirname, '../../fixtures/qoder');
const PARENT_AGENT_CALL_ID = 'fc_agent0000000000000000000000000000000000000000000000000001';
const SUBAGENT_ID = 'ageneral-purpose-0f1e2d3c4b5a6978';

let dataDir;
let transcriptPath;
let sessionDir;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-subagent-'));
  transcriptPath = path.join(dataDir, 'transcript.jsonl');
  // The session dir is transcriptPath minus .jsonl → <dataDir>/transcript/
  sessionDir = transcriptPath.replace(/\.jsonl$/, '');
});

afterEach(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function runProcessor(sessionId = 'subagent-session', extraEnv = {}) {
  return spawnSync('node', [PROCESSOR, '--agent-id', 'qoder', '--log-prefix', 'qoder'], {
    input: JSON.stringify({
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: '/tmp/qoder-subagent-project',
    }),
    env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: dataDir, ...extraEnv },
    encoding: 'utf-8',
    timeout: 30_000,
  });
}

function readHistory() {
  const historyDir = path.join(dataDir, 'logs', 'qoder', 'history');
  if (!fs.existsSync(historyDir)) return [];
  return fs.readdirSync(historyDir)
    .filter(file => file.endsWith('.jsonl'))
    .flatMap(file => fs.readFileSync(path.join(historyDir, file), 'utf-8').split('\n'))
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function copyAgentToolTranscript() {
  fs.copyFileSync(path.join(FIXTURES, 'transcript-subagent-agent-tool.jsonl'), transcriptPath);
}

/**
 * Install the real-shaped subagent task descriptor under <sessionDir>/subagents/,
 * resolving the __SESSION_DIR__ placeholder in `transcriptPath` the way qodercli
 * would have written its own absolute path.
 */
function installSubagentTask(override, subdir = 'subagents') {
  const subagentsDir = path.join(sessionDir, subdir);
  fs.mkdirSync(subagentsDir, { recursive: true });
  const task = override ?? JSON.parse(fs.readFileSync(
    path.join(FIXTURES, 'subagent-session', 'subagents', 'task-atask7c21d0e5b4f9a3c1.json'),
    'utf-8',
  ));
  fs.writeFileSync(
    path.join(subagentsDir, `task-${task.taskId}.json`),
    JSON.stringify(task).replace(/__SESSION_DIR__/g, sessionDir),
  );
  return subagentsDir;
}

function copySubagentTranscript(name = `agent-${SUBAGENT_ID}.jsonl`, subdir = 'subagents') {
  const subagentsDir = installSubagentTask(undefined, subdir);
  fs.copyFileSync(
    path.join(FIXTURES, 'subagent-session', 'subagents', name),
    path.join(subagentsDir, name),
  );
}

function subagentRecordsOf(records) {
  return records.filter(r => r['gen_ai.agent.scope'] === 'subagent');
}

const AGENT_CALL_A = PARENT_AGENT_CALL_ID;
const AGENT_CALL_B = 'fc_agent0000000000000000000000000000000000000000000000000002';
const CHILD_AGENT_B = 'ageneral-purpose-9z8y7x6w5v4u3t2s';

/**
 * Build a parent transcript with one logical Turn per entry: user prompt →
 * Agent tool_use block(s) → matching tool_results → final text → Stop. One
 * entry holding two call ids is how a parallel dispatch lands on disk.
 */
function writeParentTranscript(turns) {
  let sec = 0;
  const ts = () => {
    const stamp = `2026-09-22T${String(10 + Math.floor(sec / 3600)).padStart(2, '0')}:`
      + `${String(Math.floor(sec / 60) % 60).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}.000Z`;
    sec += 1;
    return stamp;
  };
  const rows = [{
    type: 'session_meta', sessionId: 'subagent-session', uuid: 'meta-1', timestamp: ts(),
    data: { meta_type: 'session_info', content: { mode: 'agent', session_type: 'assistant' } },
  }];
  turns.forEach((turn, i) => {
    rows.push({
      type: 'user', sessionId: 'subagent-session', uuid: `user-${i}`, timestamp: ts(),
      entrypoint: 'cli', message: { role: 'user', content: turn.prompt },
    });
    rows.push({
      type: 'assistant', sessionId: 'subagent-session', uuid: `asst-${i}`, timestamp: ts(),
      message: {
        id: `resp_parent${i}0000000000000000000000000000000000000000000000000`,
        role: 'assistant', model: 'ultimate', stop_reason: 'tool_use',
        // One assistant message carrying every block is how a parallel dispatch
        // lands on disk; sequential calls simply produce a single-element array.
        content: turn.calls.map(callId => ({
          type: 'tool_use', id: callId, name: 'Agent',
          input: { prompt: 'run echo hello in the subagent', subagent_type: 'general-purpose', description: 'echo test' },
        })),
      },
    });
    turn.calls.forEach(callId => {
      rows.push({
        type: 'user', sessionId: 'subagent-session', uuid: `result-${callId.slice(-2)}`, timestamp: ts(),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: "Subagent completed: printed 'hello'" }] },
      });
    });
    rows.push({
      type: 'assistant', sessionId: 'subagent-session', uuid: `asst-final-${i}`, timestamp: ts(),
      message: {
        id: `resp_parent_final${i}0000000000000000000000000000000000000000000000`,
        role: 'assistant', model: 'ultimate', stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'The subagent has finished the task.' }],
      },
    });
    rows.push({
      type: 'progress', sessionId: 'subagent-session', uuid: `prog-stop-${i}`, timestamp: ts(),
      data: { command: '~/.qoder/hooks/stop.sh', hookEvent: 'Stop', hookName: 'Stop', type: 'hook_progress' },
    });
  });
  rows.push({
    type: 'last-prompt', sessionId: 'subagent-session', uuid: 'last-1', timestamp: ts(),
    lastPrompt: turns[turns.length - 1].prompt,
  });
  fs.writeFileSync(transcriptPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}

/** Install one task descriptor + its child transcript, reusing the fixture's field set. */
function installChildForCall(callId, taskId, agentId) {
  const subagentsDir = path.join(sessionDir, 'subagents');
  fs.mkdirSync(subagentsDir, { recursive: true });
  const base = JSON.parse(fs.readFileSync(
    path.join(FIXTURES, 'subagent-session', 'subagents', 'task-atask7c21d0e5b4f9a3c1.json'),
    'utf-8',
  ));
  fs.writeFileSync(
    path.join(subagentsDir, `task-${taskId}.json`),
    JSON.stringify({
      ...base, taskId, agentId, parentToolUseId: callId,
      transcriptPath: path.join(subagentsDir, `agent-${agentId}.jsonl`),
    }),
  );
  fs.copyFileSync(
    path.join(FIXTURES, 'subagent-session', 'subagents', `agent-${SUBAGENT_ID}.jsonl`),
    path.join(subagentsDir, `agent-${agentId}.jsonl`),
  );
  return subagentsDir;
}

function parentAgentCalls(records) {
  return records.filter(
    r => r['event.name'] === 'tool.call' && r['gen_ai.tool.name'] === 'Agent',
  );
}

/** Minimal parent tool.call record as buildEventsFromBoundaries emits it. */
function parentAgentCallRecord(callId, turnId) {
  return {
    'event.name': 'tool.call',
    'gen_ai.tool.name': 'Agent',
    'gen_ai.tool.call.id': callId,
    'gen_ai.turn.id': turnId,
    'gen_ai.session.id': 'subagent-session',
    'gen_ai.agent.type': 'qoder',
    'gen_ai.provider.name': 'qwen',
  };
}

describe('qoder-hook-processor subagent trace collection', () => {
  it('collects subagent traces when transcript has Agent tool call with subagent task', () => {
    copyAgentToolTranscript();
    copySubagentTranscript();

    const result = runProcessor();
    expect(result.status).toBe(0);

    const records = readHistory();
    expect(records.length).toBeGreaterThan(0);

    // Verify parent turn records exist.
    const parentToolCalls = records.filter(
      r => r['event.name'] === 'tool.call' && r['gen_ai.tool.name'] === 'Agent',
    );
    expect(parentToolCalls.length).toBe(1);
    expect(parentToolCalls[0]['gen_ai.tool.call.id']).toBe(PARENT_AGENT_CALL_ID);

    // Verify subagent records exist.
    const subagentRecords = subagentRecordsOf(records);
    expect(subagentRecords.length).toBeGreaterThan(0);

    // Subagent records must share the parent turn id.
    const parentTurnId = parentToolCalls[0]['gen_ai.turn.id'];
    for (const sr of subagentRecords) {
      expect(sr['gen_ai.turn.id']).toBe(parentTurnId);
      expect(sr['gen_ai.agent.scope']).toBe('subagent');
      expect(sr['gen_ai.agent.depth']).toBe(1);
      expect(sr['gen_ai.agent.id']).toBe(SUBAGENT_ID);
      expect(sr['gen_ai.agent.name']).toBe('general-purpose');
      expect(sr['gen_ai.subagent.parent_tool_call.id']).toBe(PARENT_AGENT_CALL_ID);
    }

    // Verify subagent LLM events exist.
    const subagentResponses = subagentRecords.filter(
      r => r['event.name'] === 'llm.response',
    );
    expect(subagentResponses.length).toBeGreaterThanOrEqual(1);

    // Verify subagent tool.call/tool.result for Bash exist.
    const subagentToolCalls = subagentRecords.filter(
      r => r['event.name'] === 'tool.call',
    );
    const subagentToolResults = subagentRecords.filter(
      r => r['event.name'] === 'tool.result',
    );
    expect(subagentToolCalls.length).toBeGreaterThanOrEqual(1);
    expect(subagentToolResults.length).toBeGreaterThanOrEqual(1);

    // The subagent Bash tool call should have matching tool name.
    const bashCalls = subagentToolCalls.filter(
      r => r['gen_ai.tool.name'] === 'Bash',
    );
    expect(bashCalls.length).toBe(1);

    // The subagent model is its own (task.resolvedModel), not the parent's.
    for (const sr of subagentRecords.filter(r => r['event.name'].startsWith('llm.'))) {
      expect(sr['gen_ai.request.model'] ?? sr['gen_ai.response.model']).toBe('Qwen3.8-Flash');
    }
    const parentResponses = records.filter(
      r => r['event.name'] === 'llm.response' && r['gen_ai.agent.scope'] === undefined,
    );
    expect(parentResponses.length).toBeGreaterThan(0);
    for (const pr of parentResponses) {
      expect(pr['gen_ai.response.model']).toBe('ultimate');
    }

    // Subagent source marker should be set.
    for (const sr of subagentRecords) {
      expect(sr['agent.source']).toBe('qoder-transcript-hook');
    }
  });

  it('does not crash when no subagent tasks exist', () => {
    // Use a transcript without any Agent tool calls (standard react cycle).
    const fixtureTranscript = path.join(FIXTURES, 'transcript-react-tool-cycle.jsonl');
    fs.copyFileSync(fixtureTranscript, transcriptPath);

    const result = runProcessor('react-cycle-session');
    expect(result.status).toBe(0);

    const records = readHistory();
    expect(records.length).toBeGreaterThan(0);

    // No subagent records should exist.
    expect(subagentRecordsOf(records)).toHaveLength(0);

    // Regular tool cycles should still produce the expected events.
    const responses = records.filter(r => r['event.name'] === 'llm.response');
    expect(responses.length).toBeGreaterThan(0);
  });

  it('does not crash when subagent transcript file is missing', () => {
    copyAgentToolTranscript();

    // Create subagent task but NOT the transcript.
    installSubagentTask({
      taskId: 'ataskmissing000000001',
      agentId: 'missing-agent',
      agentType: 'general-purpose',
      description: 'missing transcript test',
      parentToolUseId: PARENT_AGENT_CALL_ID,
    });

    const result = runProcessor();
    // Should still succeed (fail-open).
    expect(result.status).toBe(0);

    const records = readHistory();
    expect(records.length).toBeGreaterThan(0);

    // Parent records should exist.
    const parentToolCalls = records.filter(
      r => r['event.name'] === 'tool.call' && r['gen_ai.tool.name'] === 'Agent',
    );
    expect(parentToolCalls.length).toBe(1);

    // No subagent records (transcript was missing, gracefully skipped).
    expect(subagentRecordsOf(records)).toHaveLength(0);
  });

  it('prefers task.transcriptPath over the agent-<agentId> file-name convention', () => {
    copyAgentToolTranscript();
    // Write the transcript under a name the file convention would never derive.
    const subagentsDir = installSubagentTask({
      taskId: 'ataskrenamed000000001',
      agentId: SUBAGENT_ID,
      agentType: 'general-purpose',
      description: 'echo test in subagent',
      parentToolUseId: PARENT_AGENT_CALL_ID,
      resolvedModel: 'Qwen3.8-Flash',
      transcriptPath: path.join(sessionDir, 'subagents', 'renamed-child.jsonl'),
    });
    fs.copyFileSync(
      path.join(FIXTURES, 'subagent-session', 'subagents', `agent-${SUBAGENT_ID}.jsonl`),
      path.join(subagentsDir, 'renamed-child.jsonl'),
    );

    const result = runProcessor();
    expect(result.status).toBe(0);
    expect(subagentRecordsOf(readHistory()).length).toBeGreaterThan(0);
  });

  it('ignores a task.transcriptPath that escapes the session subagents dir', () => {
    copyAgentToolTranscript();
    // Outside <sessionDir>/subagents/ → rejected, and the agentId fallback has no file.
    installSubagentTask({
      taskId: 'ataskescape0000000001',
      agentId: SUBAGENT_ID,
      agentType: 'general-purpose',
      description: 'echo test in subagent',
      parentToolUseId: PARENT_AGENT_CALL_ID,
      transcriptPath: path.join(sessionDir, 'renamed-child.jsonl'),
    });
    fs.copyFileSync(
      path.join(FIXTURES, 'subagent-session', 'subagents', `agent-${SUBAGENT_ID}.jsonl`),
      path.join(sessionDir, 'renamed-child.jsonl'),
    );

    const result = runProcessor();
    expect(result.status).toBe(0);
    expect(subagentRecordsOf(readHistory())).toHaveLength(0);
  });

  it('gives each subagent the turn id of the Agent call that dispatched it', () => {
    // A batch spanning two Turns only arises when the incremental cursor window
    // keeps an unrecovered Turn 1 (no Stop row to truncate at), which the Stop-hook
    // entry point will not reproduce on demand. Drive the collector directly: the
    // converter buckets by gen_ai.turn.id before it resolves
    // gen_ai.subagent.parent_tool_call.id, so a child that inherits a different
    // Turn's id is dropped without a warning instead of being nested.
    fs.writeFileSync(transcriptPath, '');
    installChildForCall(AGENT_CALL_A, 'ataskdirecta000000000001', SUBAGENT_ID);
    installChildForCall(AGENT_CALL_B, 'ataskdirectb000000000001', CHILD_AGENT_B);

    const turnA = '00000000-0000-4000-8000-00000000000a';
    const turnB = '00000000-0000-4000-8000-00000000000b';
    const children = collectSubagentRecordsForTurn(
      [parentAgentCallRecord(AGENT_CALL_A, turnA), parentAgentCallRecord(AGENT_CALL_B, turnB)],
      transcriptPath,
      'subagent-session',
      '/tmp/qoder-subagent-project',
    );

    const ofA = children.filter(r => r['gen_ai.subagent.parent_tool_call.id'] === AGENT_CALL_A);
    const ofB = children.filter(r => r['gen_ai.subagent.parent_tool_call.id'] === AGENT_CALL_B);
    expect(ofA.length).toBeGreaterThan(0);
    expect(ofB.length).toBeGreaterThan(0);
    for (const r of ofA) {
      expect(r['gen_ai.turn.id']).toBe(turnA);
      expect(r['gen_ai.agent.id']).toBe(SUBAGENT_ID);
    }
    for (const r of ofB) {
      expect(r['gen_ai.turn.id']).toBe(turnB);
      expect(r['gen_ai.agent.id']).toBe(CHILD_AGENT_B);
    }
  });

  it('keeps parallel subagents of one turn distinguishable by parent tool call id', () => {
    writeParentTranscript([
      { prompt: 'delegate two echoes at once', calls: [AGENT_CALL_A, AGENT_CALL_B] },
    ]);
    installChildForCall(AGENT_CALL_A, 'ataskpara0a00000000000001', SUBAGENT_ID);
    installChildForCall(AGENT_CALL_B, 'ataskpara0b00000000000001', CHILD_AGENT_B);

    const result = runProcessor();
    expect(result.status).toBe(0);

    const records = readHistory();
    const parents = parentAgentCalls(records);
    expect(parents.length).toBe(2);

    const sharedTurnId = parents[0]['gen_ai.turn.id'];
    for (const p of parents) expect(p['gen_ai.turn.id']).toBe(sharedTurnId);

    const children = subagentRecordsOf(records);
    const agentIds = new Set(children.map(r => r['gen_ai.agent.id']));
    expect([...agentIds].sort()).toEqual([CHILD_AGENT_B, SUBAGENT_ID].sort());

    // Each child group points at its own parent call and shares the turn id.
    const groups = new Map();
    for (const r of children) {
      expect(r['gen_ai.turn.id']).toBe(sharedTurnId);
      const key = r['gen_ai.subagent.parent_tool_call.id'];
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    expect([...groups.keys()].sort()).toEqual([AGENT_CALL_A, AGENT_CALL_B].sort());
    for (const count of groups.values()) expect(count).toBeGreaterThan(0);

    // Step ids group the records of one ReAct step, so uniqueness is per group;
    // the invariant is that the two subagents never share a step.
    const stepsOf = callId => new Set(
      children.filter(r => r['gen_ai.subagent.parent_tool_call.id'] === callId)
        .map(r => r['gen_ai.step.id']),
    );
    const stepsA = stepsOf(AGENT_CALL_A);
    const stepsB = stepsOf(AGENT_CALL_B);
    expect(stepsA.size).toBeGreaterThan(0);
    expect([...stepsA].filter(s => stepsB.has(s))).toHaveLength(0);
  });
});
