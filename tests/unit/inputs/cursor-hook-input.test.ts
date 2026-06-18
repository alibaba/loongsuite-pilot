import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { ClientType } from '../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { CursorHookInput } from '../../../src/inputs/cursor-hook/cursor-hook-input.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';

const execFile = promisify(execFileCb);

function getTodayDateString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

describe('CursorHookInput', () => {
  let tmpDir: string;
  let stateStore: MockStateStore;
  let input: CursorHookInput;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-hook-input-test-'));
    stateStore = new MockStateStore();
    input = new CursorHookInput({
      stateStore: stateStore as any,
      logDir: tmpDir,
      logPrefix: 'cursor',
      pollIntervalMs: 60_000,
    });
  });

  afterEach(async () => {
    if (input.running) await input.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('maps raw preToolUse hook record to tool.call event_t fields', async () => {
    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `cursor-${today}.jsonl`);
    const record = {
      'event.id': 'r-1',
      observed_time_unix_nano: '1777628163513000000',
      time_unix_nano: '1777628163513000000',
      hook_event_name: 'preToolUse',
      conversation_id: 'sess-1',
      generation_id: 'turn-1',
      message_id: 'msg-1',
      model: 'gpt-5.5',
      repo: 'sls/loongsuite-pilot',
      branch: 'feature/source-contract',
      domain: 'github.com',
      workspace_roots: ['/workspace', '/workspace/project'],
      tool_name: 'Shell',
      tool_use_id: 'tool-1',
      tool_input: {
        command: 'echo hello',
        cwd: '/workspace/project',
      },
    };
    await fs.writeFile(logFile, `${JSON.stringify(record)}\n`);

    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(1);
    expect(entries[0]!['gen_ai.agent.type']).toBe(ClientType.Cursor);
    expect(entries[0]!['event.name']).toBe('tool.call');
    expect(entries[0]!['gen_ai.session.id']).toBe('sess-1');
    expect(entries[0]!['gen_ai.turn.id']).toBe('turn-1');
    expect(entries[0]!['gen_ai.tool.name']).toBe('Shell');
    expect(entries[0]!['gen_ai.tool.call.id']).toBe('tool-1');
    expect(entries[0]!['gen_ai.tool.call.arguments']).toEqual({ command: 'echo hello', cwd: '/workspace/project' });
    expect(entries[0]!['gen_ai.request.model']).toBe('gpt-5.5');
    expect(entries[0]!['gen_ai.response.model']).toBe('gpt-5.5');
    expect(entries[0]!['git.repo']).toBe('sls/loongsuite-pilot');
    expect(entries[0]!['git.branch']).toBe('feature/source-contract');
    expect(entries[0]!['git.domain']).toBe('github.com');
    expect(entries[0]!['workspace.current_root']).toBe('/workspace/project');
  });

  it('prefers canonical hook records when present', async () => {
    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `cursor-${today}.jsonl`);
    const record = {
      'event.id': 'canonical-1',
      'event.name': 'tool.call',
      time_unix_nano: '1777628163513000000',
      observed_time_unix_nano: '1777628163513000000',
      'user.id': 'hook-user',
      'gen_ai.agent.type': ClientType.Cursor,
      'gen_ai.provider.name': 'openai',
      'gen_ai.session.id': 'sess-canonical',
      'gen_ai.tool.name': 'Shell',
      'gen_ai.tool.call.id': 'tool-canonical',
      'gen_ai.tool.call.arguments': { command: 'pwd' },
      hook_event_name: 'preToolUse',
    };
    await fs.writeFile(logFile, `${JSON.stringify(record)}\n`);

    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      'event.id': 'canonical-1',
      'event.name': 'tool.call',
      'user.id': 'hook-user',
      'gen_ai.agent.type': ClientType.Cursor,
      'gen_ai.provider.name': 'openai',
      'gen_ai.session.id': 'sess-canonical',
      'gen_ai.tool.name': 'Shell',
      'gen_ai.tool.call.id': 'tool-canonical',
      'gen_ai.tool.call.arguments': { command: 'pwd' },
      'agent.cursor.hook_event_name': 'preToolUse',
    });
    expect(entries[0]!['agent.hook_event_name']).toBeUndefined();
  });

  it('maps raw postToolUse hook record to tool.result event_t fields', async () => {
    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `cursor-${today}.jsonl`);
    const record = {
      'event.id': 'r-2',
      observed_time_unix_nano: '1777628163513000000',
      time_unix_nano: '1777628163513000000',
      hook_event_name: 'postToolUse',
      session_id: 'sess-from-raw',
      tool_name: 'Shell',
      tool_use_id: 'tool-2',
      tool_output: '{"output":"ok","exitCode":0}',
      duration: 12.5,
    };
    await fs.writeFile(logFile, `${JSON.stringify(record)}\n`);

    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(1);
    expect(entries[0]!['event.name']).toBe('tool.result');
    expect(entries[0]!['gen_ai.session.id']).toBe('sess-from-raw');
    expect(entries[0]!['gen_ai.request.model']).toBe('composer-2.5');
    expect(entries[0]!['gen_ai.response.model']).toBe('composer-2.5');
    expect(entries[0]!['gen_ai.tool.call.result']).toEqual({ output: 'ok', exitCode: 0 });
    expect(entries[0]!['gen_ai.tool.call.duration']).toBe(12.5);
  });

  it('maps agent thought to llm.response output messages', async () => {
    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `cursor-${today}.jsonl`);
    const record = {
      'event.id': 'r-3',
      observed_time_unix_nano: '1777628163513000000',
      time_unix_nano: '1777628163513000000',
      hook_event_name: 'afterAgentThought',
      session_id: 's-thought',
      text: 'thinking...',
      model: 'gpt-5.5',
    };
    await fs.writeFile(logFile, `${JSON.stringify(record)}\n`);

    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(1);
    expect(entries[0]!['event.name']).toBe('llm.response');
    expect(entries[0]!['gen_ai.output.messages']).toEqual([{ role: 'assistant', parts: [{ type: 'reasoning', content: 'thinking...' }] }]);
  });

  it('maps prompt, token, and cost fields', async () => {
    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `cursor-${today}.jsonl`);
    const record = {
      'event.id': 'r-4',
      observed_time_unix_nano: '1777628163513000000',
      time_unix_nano: '1777628163513000000',
      hook_event_name: 'beforeSubmitPrompt',
      session_id: 's-prompt',
      generation_id: 'turn-prompt',
      model: 'gpt-5.5',
      prompt: 'please inspect this',
      input_tokens: 10,
      output_tokens: 4,
      cache_read_tokens: 2,
      cache_write_tokens: 1,
      cost_input: 0.1,
      cost_output: 0.2,
      user_email: 'cursor@example.com',
      transcript_path: '/tmp/transcript.jsonl',
    };
    await fs.writeFile(logFile, `${JSON.stringify(record)}\n`);

    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(1);
    expect(entries[0]!['event.name']).toBe('other');
    expect(entries[0]!['user.id']).toBe('');
    expect(entries[0]!['gen_ai.input.messages_delta']).toEqual([{ role: 'user', parts: [{ type: 'text', content: 'please inspect this' }] }]);
    expect(entries[0]!['gen_ai.usage.input_tokens']).toBe(10);
    expect(entries[0]!['gen_ai.usage.output_tokens']).toBe(4);
    expect(entries[0]!['gen_ai.usage.total_tokens']).toBe(14);
    expect(entries[0]!['gen_ai.usage.cache_read.input_tokens']).toBe(2);
    expect(entries[0]!['gen_ai.usage.cache_creation.input_tokens']).toBe(1);
    expect(entries[0]!['gen_ai.usage.input_cost']).toBe(0.1);
    expect(entries[0]!['gen_ai.usage.output_cost']).toBe(0.2);
    expect(entries[0]!['agent.user_email']).toBe('cursor@example.com');
    expect(entries[0]!['agent.transcript_path']).toBe('/tmp/transcript.jsonl');
  });

  it('maps postToolUseFailure to error fields', async () => {
    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `cursor-${today}.jsonl`);
    const record = {
      'event.id': 'r-5',
      observed_time_unix_nano: '1777628163513000000',
      time_unix_nano: '1777628163513000000',
      hook_event_name: 'postToolUseFailure',
      session_id: 's-fail',
      tool_name: 'Shell',
      tool_use_id: 'tool-fail',
      error_message: 'tool failed',
    };
    await fs.writeFile(logFile, `${JSON.stringify(record)}\n`);

    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(1);
    expect(entries[0]!['event.name']).toBe('tool.result');
    expect(entries[0]!['error.type']).toBe('tool_use_failure');
    expect(entries[0]!['error.message']).toBe('tool failed');
  });

  it('does not map generic message to error.message for normal events', async () => {
    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `cursor-${today}.jsonl`);
    const record = {
      'event.id': 'r-6',
      observed_time_unix_nano: '1777628163513000000',
      time_unix_nano: '1777628163513000000',
      hook_event_name: 'sessionStart',
      session_id: 's-message',
      message: 'normal lifecycle message',
    };
    await fs.writeFile(logFile, `${JSON.stringify(record)}\n`);

    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(1);
    expect(entries[0]!['event.name']).toBe('other');
    expect(entries[0]!['gen_ai.request.model']).toBe('composer-2.5');
    expect(entries[0]!['gen_ai.response.model']).toBe('composer-2.5');
    expect(entries[0]!['error.message']).toBeUndefined();
  });

  it('infers git repo and branch from workspace.current_root when payload fields are missing', async () => {
    const repoDir = path.join(tmpDir, 'repo');
    await fs.mkdir(repoDir, { recursive: true });
    await execFile('git', ['init', '-b', 'feature/infer-git'], { cwd: repoDir });
    await execFile('git', ['config', 'user.name', 'cursor-test'], { cwd: repoDir });
    await execFile('git', ['config', 'user.email', 'cursor-test@example.com'], { cwd: repoDir });
    await execFile('git', ['remote', 'add', 'origin', 'git@github.com:acme/agent-collector.git'], { cwd: repoDir });
    await fs.writeFile(path.join(repoDir, 'README.md'), 'ok\n', 'utf-8');
    await execFile('git', ['add', 'README.md'], { cwd: repoDir });
    await execFile('git', ['commit', '-m', 'init'], { cwd: repoDir });

    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `cursor-${today}.jsonl`);
    const record = {
      'event.id': 'r-7',
      observed_time_unix_nano: '1777628163513000000',
      time_unix_nano: '1777628163513000000',
      hook_event_name: 'postToolUse',
      session_id: 's-infer',
      tool_name: 'Read',
      tool_use_id: 'tool-infer',
      tool_output: '{"content_length":12}',
      workspace_roots: [repoDir],
      cwd: repoDir,
    };
    await fs.writeFile(logFile, `${JSON.stringify(record)}\n`);

    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(1);
    expect(entries[0]!['workspace.current_root']).toBe(repoDir);
    expect(entries[0]!['git.repo']).toBe('acme/agent-collector');
    expect(entries[0]!['git.branch']).toBe('feature/infer-git');
    expect(entries[0]!['git.domain']).toBe('github.com');
  });

  it('keeps git fields empty when root is not a git repository', async () => {
    const nonRepoDir = path.join(tmpDir, 'non-repo');
    await fs.mkdir(nonRepoDir, { recursive: true });

    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `cursor-${today}.jsonl`);
    const record = {
      'event.id': 'r-8',
      observed_time_unix_nano: '1777628163513000000',
      time_unix_nano: '1777628163513000000',
      hook_event_name: 'postToolUse',
      session_id: 's-no-git',
      tool_name: 'Read',
      tool_use_id: 'tool-no-git',
      tool_output: '{"content_length":7}',
      workspace_roots: [nonRepoDir],
      cwd: nonRepoDir,
    };
    await fs.writeFile(logFile, `${JSON.stringify(record)}\n`);

    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(1);
    expect(entries[0]!['workspace.current_root']).toBe(nonRepoDir);
    expect(entries[0]!['git.repo']).toBeUndefined();
    expect(entries[0]!['git.branch']).toBeUndefined();
    expect(entries[0]!['git.domain']).toBeUndefined();
  });

  it('keeps workspace root but infers git from cwd repository root', async () => {
    const workspaceDir = path.join(tmpDir, 'workspace');
    const repoDir = path.join(workspaceDir, 'repo-a');
    const workDir = path.join(repoDir, 'subdir');
    await fs.mkdir(workDir, { recursive: true });
    await execFile('git', ['init', '-b', 'feature/ws-vs-git'], { cwd: repoDir });
    await execFile('git', ['config', 'user.name', 'cursor-test'], { cwd: repoDir });
    await execFile('git', ['config', 'user.email', 'cursor-test@example.com'], { cwd: repoDir });
    await execFile('git', ['remote', 'add', 'origin', 'git@github.com:acme/workspace-vs-git.git'], { cwd: repoDir });
    await fs.writeFile(path.join(repoDir, 'README.md'), 'ok\n', 'utf-8');
    await execFile('git', ['add', 'README.md'], { cwd: repoDir });
    await execFile('git', ['commit', '-m', 'init'], { cwd: repoDir });

    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `cursor-${today}.jsonl`);
    const record = {
      'event.id': 'r-9',
      observed_time_unix_nano: '1777628163513000000',
      time_unix_nano: '1777628163513000000',
      hook_event_name: 'postToolUse',
      session_id: 's-ws-git',
      tool_name: 'Read',
      tool_use_id: 'tool-ws-git',
      tool_output: '{"content_length":7}',
      workspace_roots: [workspaceDir],
      cwd: workDir,
    };
    await fs.writeFile(logFile, `${JSON.stringify(record)}\n`);

    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(1);
    expect(entries[0]!['workspace.current_root']).toBe(workspaceDir);
    expect(entries[0]!['git.repo']).toBe('acme/workspace-vs-git');
    expect(entries[0]!['git.branch']).toBe('feature/ws-vs-git');
    expect(entries[0]!['git.domain']).toBe('github.com');
  });

  it('falls back to cached cd path from preToolUse command when git fields are missing', async () => {
    const repoDir = path.join(tmpDir, 'fallback-repo');
    await fs.mkdir(repoDir, { recursive: true });
    await execFile('git', ['init', '-b', 'feature/fallback-cd'], { cwd: repoDir });
    await execFile('git', ['config', 'user.name', 'cursor-test'], { cwd: repoDir });
    await execFile('git', ['config', 'user.email', 'cursor-test@example.com'], { cwd: repoDir });
    await execFile('git', ['remote', 'add', 'origin', 'git@github.com:acme/fallback-cd.git'], { cwd: repoDir });
    await fs.writeFile(path.join(repoDir, 'README.md'), 'ok\n', 'utf-8');
    await execFile('git', ['add', 'README.md'], { cwd: repoDir });
    await execFile('git', ['commit', '-m', 'init'], { cwd: repoDir });

    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `cursor-${today}.jsonl`);

    // preToolUse record with cd command in tool_input — no repo/branch/workspace_roots
    const preToolUseRecord = {
      'event.id': 'r-10',
      observed_time_unix_nano: '1777628163513000000',
      time_unix_nano: '1777628163513000000',
      hook_event_name: 'preToolUse',
      session_id: 's-fallback',
      generation_id: 'turn-1',
      tool_name: 'Shell',
      tool_use_id: 'tool-1',
      tool_input: {
        command: `cd ${repoDir} && git status`,
      },
    };

    // llm.request record in the same session — also no repo/branch/workspace_roots
    const llmRequestRecord = {
      'event.id': 'r-11',
      observed_time_unix_nano: '1777628163513001000',
      time_unix_nano: '1777628163513001000',
      hook_event_name: 'beforeSubmitPrompt',
      session_id: 's-fallback',
      generation_id: 'turn-2',
      prompt: 'hello',
    };

    await fs.writeFile(
      logFile,
      `${JSON.stringify(preToolUseRecord)}\n${JSON.stringify(llmRequestRecord)}\n`,
    );

    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(2);

    // preToolUse entry should have cached the cd path but no git info because
    // workspace_roots is absent and payload has no repo/branch
    expect(entries[0]!['event.name']).toBe('tool.call');

    // beforeSubmitPrompt entry should use the cached cd path to infer git info
    expect(entries[1]!['event.name']).toBe('other');
    expect(entries[1]!['gen_ai.session.id']).toBe('s-fallback');
    expect(entries[1]!['git.repo']).toBe('acme/fallback-cd');
    expect(entries[1]!['git.branch']).toBe('feature/fallback-cd');
    expect(entries[1]!['git.domain']).toBe('github.com');
  });

  it('strips token/cost fields from legacy stop records to avoid duplication', async () => {
    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `cursor-${today}.jsonl`);
    const record = {
      'event.id': 'r-stop-legacy',
      observed_time_unix_nano: '1777628163513000000',
      time_unix_nano: '1777628163513000000',
      hook_event_name: 'stop',
      session_id: 'sess-stop',
      generation_id: 'turn-stop',
      model: 'gpt-5.5',
      input_tokens: 15809,
      output_tokens: 141,
      cache_read_tokens: 7424,
      cache_write_tokens: 0,
      total_tokens: 15950,
      status: 'completed',
      loop_count: 0,
    };
    await fs.writeFile(logFile, `${JSON.stringify(record)}\n`);

    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(1);
    expect(entries[0]!['event.name']).toBe('other');
    expect(entries[0]!['gen_ai.session.id']).toBe('sess-stop');
    expect(entries[0]!['gen_ai.usage.input_tokens']).toBeUndefined();
    expect(entries[0]!['gen_ai.usage.output_tokens']).toBeUndefined();
    expect(entries[0]!['gen_ai.usage.cache_read.input_tokens']).toBeUndefined();
    expect(entries[0]!['gen_ai.usage.cache_creation.input_tokens']).toBeUndefined();
    expect(entries[0]!['gen_ai.usage.total_tokens']).toBeUndefined();
  });

  it('strips token fields from canonical stop records to avoid duplication', async () => {
    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `cursor-${today}.jsonl`);
    const record = {
      'event.id': 'r-stop-canonical',
      'event.name': 'other',
      'gen_ai.agent.type': 'cursor',
      'gen_ai.session.id': 'sess-stop-c',
      'gen_ai.turn.id': 'turn-stop-c',
      'gen_ai.request.model': 'gpt-5.5',
      'gen_ai.response.model': 'gpt-5.5',
      'gen_ai.usage.input_tokens': 15809,
      'gen_ai.usage.output_tokens': 141,
      'gen_ai.usage.total_tokens': 15950,
      'agent.cursor.hook_event_name': 'stop',
      'agent.cursor.status': 'completed',
      'agent.cursor.loop_count': 0,
      observed_time_unix_nano: '1777628163513000000',
      time_unix_nano: '1777628163513000000',
    };
    await fs.writeFile(logFile, `${JSON.stringify(record)}\n`);

    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(1);
    expect(entries[0]!['event.name']).toBe('other');
    expect(entries[0]!['gen_ai.session.id']).toBe('sess-stop-c');
    expect(entries[0]!['gen_ai.usage.input_tokens']).toBeUndefined();
    expect(entries[0]!['gen_ai.usage.output_tokens']).toBeUndefined();
    expect(entries[0]!['gen_ai.usage.total_tokens']).toBeUndefined();
  });

  it('preserves token fields on afterAgentResponse records', async () => {
    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `cursor-${today}.jsonl`);
    const record = {
      'event.id': 'r-resp',
      observed_time_unix_nano: '1777628163513000000',
      time_unix_nano: '1777628163513000000',
      hook_event_name: 'afterAgentResponse',
      session_id: 'sess-resp',
      generation_id: 'turn-resp',
      model: 'gpt-5.5',
      input_tokens: 15809,
      output_tokens: 141,
      cache_read_tokens: 7424,
      total_tokens: 15950,
      text: 'hello world',
    };
    await fs.writeFile(logFile, `${JSON.stringify(record)}\n`);

    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(1);
    expect(entries[0]!['event.name']).toBe('llm.response');
    expect(entries[0]!['gen_ai.usage.input_tokens']).toBe(15809);
    expect(entries[0]!['gen_ai.usage.output_tokens']).toBe(141);
    expect(entries[0]!['gen_ai.usage.cache_read.input_tokens']).toBe(7424);
    expect(entries[0]!['gen_ai.usage.total_tokens']).toBe(15950);
  });
});
