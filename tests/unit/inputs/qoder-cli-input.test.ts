import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClientType } from '../../../src/types/index.js';
import type { AgentActivityEntry, SerializedLogEntry } from '../../../src/types/index.js';
import { QoderCliInput } from '../../../src/inputs/qoder-cli/qoder-cli-input.js';
import { JsonlFlusher } from '../../../src/flushers/jsonl-flusher.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';

function getTodayDateString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

describe('QoderCliInput', () => {
  let tmpDir: string;
  let stateStore: MockStateStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qcli-test-'));
    stateStore = new MockStateStore();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('keeps compatibility identity and history path defaults', () => {
    const input = makeInput();

    expect(input.id).toBe('qoder-cli-hook');
    expect(input.agentType).toBe(ClientType.QoderCli);
  });

  it('maps CLI user rows to qoder-cli llm.request entries', async () => {
    const entries = await collectRows([await fixtureRow('raw-qoder-cli.jsonl', 1)]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      'event.name': 'llm.request',
      'gen_ai.agent.type': ClientType.QoderCli,
      'event.id': 'user:c657a8f6-b0d0-472a-acd2-a368e9d94a71########1',
      'gen_ai.session.id': 'c657a8f6-b0d0-472a-acd2-a368e9d94a71',
      'gen_ai.request.model': 'unknown',
      'gen_ai.response.model': 'unknown',
    });
    expect(entries[0]?.['gen_ai.turn.id']).toBeUndefined();
    expect(entries[0]?.['gen_ai.request.id']).toBeUndefined();
    expect(entries[0]?.['gen_ai.input.messages_delta']).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'hi, good night' }] },
    ]);
    expect(entries[0]?.['agent.source']).toBe('qoder-transcript-hook');
    expect(entries[0]?.['agent.qoder_variant']).toBe('qoder-cli');
    expect(entries[0]?.['agent.raw_type']).toBe('user');
    expect(entries[0]?.['agent.entrypoint']).toBe('cli');
    expect(entries[0]?.['agent.cwd']).toBe('/Users/lukechen/.qoder/projects/-Users-lukechen-ai-agent-audit/transcript');
  });

  it('prefers canonical hook records when present', async () => {
    const entries = await collectRows([{
      'event.id': 'canonical-qoder-1',
      'event.name': 'llm.response',
      time_unix_nano: '1777628163513000000',
      observed_time_unix_nano: '1777628163513000000',
      'user.id': 'hook-user',
      'gen_ai.agent.type': ClientType.QoderCli,
      'gen_ai.provider.name': 'qwen',
      'gen_ai.session.id': 'sess-canonical-q',
      'gen_ai.response.model': 'qwen-max',
      'gen_ai.output.messages': [{ type: 'text', content: 'hello' }],
      'agent.source': 'qoder-transcript-hook',
    }]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      'event.id': 'canonical-qoder-1',
      'event.name': 'llm.response',
      'user.id': 'hook-user',
      'gen_ai.agent.type': ClientType.QoderCli,
      'gen_ai.provider.name': 'qwen',
      'gen_ai.session.id': 'sess-canonical-q',
      'gen_ai.response.model': 'qwen-max',
      'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: 'hello' }] }],
      'agent.source': 'qoder-transcript-hook',
    });
  });

  it('maps IDE user rows to qoder llm.request entries', async () => {
    const entries = await collectRows([await fixtureRow('raw-qoder-ide.jsonl', 3)]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      'event.name': 'llm.request',
      'gen_ai.agent.type': ClientType.Qoder,
      'event.id': '4279a1bc-a6e2-4cae-a086-359d2051dd6d',
      'gen_ai.session.id': 'a7eaeff7-f187-463f-bc66-304a7d76fa6e',
      'gen_ai.request.model': 'unknown',
      'gen_ai.response.model': 'unknown',
    });
    expect(entries[0]?.['gen_ai.request.id']).toBeUndefined();
    expect(entries[0]?.['gen_ai.input.messages_delta']).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'woooo!' }] },
    ]);
    expect(entries[0]?.['agent.source']).toBe('qoder-transcript-hook');
    expect(entries[0]?.['agent.qoder_variant']).toBe('qoder');
    expect(entries[0]?.['agent.raw_type']).toBe('user');
    expect(entries[0]?.['agent.cwd']).toBe('/Users/lukechen/ai-agent-audit');
  });

  it('maps assistant text and thinking rows to llm.response output messages', async () => {
    const entries = await collectRows([
      await fixtureRow('raw-qoder-cli.jsonl', 2),
      await fixtureRow('raw-qoder-cli.jsonl', 3),
    ]);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      'event.name': 'llm.response',
      'gen_ai.agent.type': ClientType.QoderCli,
      'gen_ai.request.model': 'auto',
      'gen_ai.response.model': 'auto',
      'gen_ai.response.id': '2026050202152442e8836f99bb4830',
    });
    expect(entries[0]?.['gen_ai.output.messages']).toEqual([
      { role: 'assistant', parts: [{ type: 'reasoning', content: 'The user is just greeting me casually.' }] },
    ]);
    expect(entries[1]).toMatchObject({
      'event.name': 'llm.response',
      'gen_ai.response.id': '2026050202152442e8836f99bb4830',
      'gen_ai.response.finish_reasons': ['end_turn'],
    });
    expect(entries[1]?.['gen_ai.output.messages']).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'Good night! How can I help you?' }] },
    ]);
  });

  it('maps assistant tool_use rows to tool.call entries for both schemas', async () => {
    const entries = await collectRows([
      await fixtureRow('raw-qoder-cli.jsonl', 11),
      await fixtureRow('raw-qoder-ide.jsonl', 26),
    ]);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      'event.name': 'tool.call',
      'gen_ai.agent.type': ClientType.QoderCli,
      'gen_ai.tool.call.id': 'chatcmpl-tool-aea4a8099dc32836',
      'gen_ai.tool.name': 'Bash',
    });
    expect(entries[0]?.['gen_ai.tool.call.arguments']).toEqual({
      command: 'ls',
      description: 'List files in current directory',
    });
    expect(entries[1]).toMatchObject({
      'event.name': 'tool.call',
      'gen_ai.agent.type': ClientType.Qoder,
      'gen_ai.tool.call.id': 'call_1c6e9e8b14254b9a9e3d64dc',
      'gen_ai.tool.name': 'list_dir',
      'gen_ai.request.model': 'unknown',
      'gen_ai.response.model': 'unknown',
    });
    expect(entries[1]?.['gen_ai.tool.call.arguments']).toEqual({ path: '/Users/lukechen/ai-agent-audit' });
  });

  it('maps user tool_result rows to tool.result entries for both schemas', async () => {
    const entries = await collectRows([
      await fixtureRow('raw-qoder-cli.jsonl', 13),
      await fixtureRow('raw-qoder-ide.jsonl', 27),
    ]);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      'event.name': 'tool.result',
      'gen_ai.agent.type': ClientType.QoderCli,
      'gen_ai.tool.call.id': 'chatcmpl-tool-aea4a8099dc32836',
      'gen_ai.request.model': 'unknown',
      'gen_ai.response.model': 'unknown',
    });
    expect(entries[0]?.['gen_ai.tool.call.result']).toMatchObject({
      stdout: expect.stringContaining('248bc65e'),
      stderr: '',
    });
    expect(entries[1]).toMatchObject({
      'event.name': 'tool.result',
      'gen_ai.agent.type': ClientType.Qoder,
      'gen_ai.tool.call.id': 'call_1c6e9e8b14254b9a9e3d64dc',
    });
    expect(entries[1]?.['gen_ai.tool.call.result']).toContain('Contents of directory');
  });

  it('ignores metadata and progress rows', async () => {
    const entries = await collectRows([
      await fixtureRow('raw-qoder-cli.jsonl', 4),
      await fixtureRow('raw-qoder-cli.jsonl', 5),
      await fixtureRow('raw-qoder-ide.jsonl', 2),
      await fixtureRow('raw-qoder-ide.jsonl', 6),
    ]);

    expect(entries).toHaveLength(0);
  });

  it('maps legacy PostToolUse records to standard tool.result entries', async () => {
    const entries = await collectRows([{
      event_type: 'PostToolUse',
      tool_name: 'write_to_file',
      tool_input: { file_path: '/src/app.ts', content: 'hello' },
      session_id: 'sess-1',
      user_id: 'u1',
      timestamp: Date.now(),
    }]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      'event.name': 'tool.result',
      'gen_ai.agent.type': ClientType.QoderCli,
      'gen_ai.session.id': 'sess-1',
      'user.id': 'u1',
      'gen_ai.request.model': 'unknown',
      'gen_ai.response.model': 'unknown',
      'gen_ai.tool.name': 'write_to_file',
    });
    expect(entries[0]?.['gen_ai.tool.call.arguments']).toEqual({
      file_path: '/src/app.ts',
      content: 'hello',
    });
    expect(entries[0]?.['agent.source']).toBe('qoder-transcript-hook');
    expect(entries[0]?.['agent.qoder_variant']).toBe('qoder-cli');
    expect(entries[0]?.['agent.raw_type']).toBe('PostToolUse');
    expect(entries[0]?.['agent.file_path']).toBe('/src/app.ts');
  });

  it('serializes inferred qoder and qoder-cli entries to separate JSONL files', async () => {
    const entries = await collectRows([
      await fixtureRow('raw-qoder-cli.jsonl', 1),
      await fixtureRow('raw-qoder-ide.jsonl', 3),
    ]);
    const outputDir = path.join(tmpDir, 'output');
    const flusher = new JsonlFlusher({
      enabled: true,
      outputDir,
      rotateDaily: true,
      maxFileSizeMb: 100,
    });
    await flusher.start();
    await flusher.sendBatch(entries);

    const today = getTodayDateString();
    const qoderCliLine = await readSingleJsonl(path.join(outputDir, `qoder-cli-${today}.jsonl`));
    const qoderLine = await readSingleJsonl(path.join(outputDir, `qoder-${today}.jsonl`));

    expect(qoderCliLine['gen_ai.agent.type']).toBe('qoder-cli');
    expect(qoderLine['gen_ai.agent.type']).toBe('qoder');
  });

  it('infers git fields from cwd when inside a git repository', async () => {
    const { execFile: execFileCb } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFile = promisify(execFileCb);

    const repoDir = path.join(tmpDir, 'qoder-repo');
    await fs.mkdir(repoDir, { recursive: true });
    await execFile('git', ['init', '-b', 'feature/qoder-git'], { cwd: repoDir });
    await execFile('git', ['config', 'user.name', 'qoder-test'], { cwd: repoDir });
    await execFile('git', ['config', 'user.email', 'qoder-test@example.com'], { cwd: repoDir });
    await execFile('git', ['remote', 'add', 'origin', 'git@github.com:acme/qoder-test.git'], { cwd: repoDir });
    await fs.writeFile(path.join(repoDir, 'README.md'), 'ok\n', 'utf-8');
    await execFile('git', ['add', 'README.md'], { cwd: repoDir });
    await execFile('git', ['commit', '-m', 'init'], { cwd: repoDir });

    const record = {
      type: 'user',
      uuid: 'test-git-1',
      timestamp: '2026-05-07T10:00:00.000Z',
      cwd: repoDir,
      message: { role: 'user', content: 'hello' },
      sessionId: 'sess-git',
      entrypoint: 'cli',
    };

    const entries = await collectRows([record]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!['git.repo']).toBe('acme/qoder-test');
    expect(entries[0]!['git.branch']).toBe('feature/qoder-git');
    expect(entries[0]!['git.domain']).toBe('github.com');
    expect(entries[0]!['git.repo_root']).toContain('qoder-repo');
    expect(entries[0]!['workspace.current_root']).toContain('qoder-repo');
  });

  it('leaves git fields empty when cwd is not a git repository', async () => {
    const nonRepoDir = path.join(tmpDir, 'non-repo');
    await fs.mkdir(nonRepoDir, { recursive: true });

    const record = {
      type: 'user',
      uuid: 'test-no-git-1',
      timestamp: '2026-05-07T10:00:00.000Z',
      cwd: nonRepoDir,
      message: { role: 'user', content: 'hello' },
      sessionId: 'sess-no-git',
      entrypoint: 'cli',
    };

    const entries = await collectRows([record]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!['git.repo']).toBeUndefined();
    expect(entries[0]!['git.branch']).toBeUndefined();
    expect(entries[0]!['git.domain']).toBeUndefined();
    expect(entries[0]!['git.repo_root']).toBeUndefined();
    expect(entries[0]!['workspace.current_root']).toBeUndefined();
  });

  async function collectRows(records: Record<string, unknown>[]): Promise<AgentActivityEntry[]> {
    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `qoder-${today}.jsonl`);
    await fs.writeFile(logFile, records.map(r => JSON.stringify(r)).join('\n') + '\n');

    const input = makeInput();
    const allEntries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));
    await input.start();
    await input.stop();
    return allEntries;
  }

  function makeInput(): QoderCliInput {
    return new QoderCliInput({
      stateStore: stateStore as any,
      logDir: tmpDir,
      logPrefix: 'qoder',
      pollIntervalMs: 60_000,
    });
  }
});

async function fixtureRow(fileName: string, lineNumber: number): Promise<Record<string, unknown>> {
  const fixture = fileName === 'raw-qoder-cli.jsonl'
    ? CLI_FIXTURE[lineNumber]
    : IDE_FIXTURE[lineNumber];
  if (!fixture) throw new Error(`Missing fixture line ${fileName}:${lineNumber}`);
  return structuredClone(fixture);
}

async function readSingleJsonl(filePath: string): Promise<SerializedLogEntry> {
  const raw = await fs.readFile(filePath, 'utf-8');
  const lines = raw.split('\n').filter(line => line.trim().length > 0);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]) as SerializedLogEntry;
}

const CLI_FIXTURE: Record<number, Record<string, unknown>> = {
  1: {
    type: 'user',
    uuid: 'user:c657a8f6-b0d0-472a-acd2-a368e9d94a71########1',
    timestamp: '2026-05-01T18:15:22.122Z',
    message: { role: 'user', content: 'hi, good night' },
    permissionMode: 'default',
    promptId: 'b62b1882-8f5a-43d6-8f6e-3868eca4cdbc',
    parentUuid: null,
    cwd: '/Users/lukechen/.qoder/projects/-Users-lukechen-ai-agent-audit/transcript',
    sessionId: 'c657a8f6-b0d0-472a-acd2-a368e9d94a71',
    userType: 'external',
    entrypoint: 'cli',
    version: '0.2.0',
  },
  2: {
    type: 'assistant',
    uuid: '7f613963-6e1f-4105-ba47-e1ae3993762d',
    timestamp: '2026-05-01T18:15:28.060Z',
    message: {
      id: '2026050202152442e8836f99bb4830',
      role: 'assistant',
      model: 'auto',
      content: [{ type: 'thinking', thinking: 'The user is just greeting me casually.' }],
    },
    sessionId: 'c657a8f6-b0d0-472a-acd2-a368e9d94a71',
    entrypoint: 'cli',
  },
  3: {
    type: 'assistant',
    uuid: '9facec46-c14a-461a-b316-7c3a3d75ed97',
    timestamp: '2026-05-01T18:15:28.166Z',
    message: {
      id: '2026050202152442e8836f99bb4830',
      role: 'assistant',
      model: 'auto',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Good night! How can I help you?' }],
    },
    sessionId: 'c657a8f6-b0d0-472a-acd2-a368e9d94a71',
    entrypoint: 'cli',
  },
  4: { type: 'last-prompt', sessionId: 'c657a8f6-b0d0-472a-acd2-a368e9d94a71', lastPrompt: 'hi' },
  5: { type: 'ai-title', sessionId: 'c657a8f6-b0d0-472a-acd2-a368e9d94a71', aiTitle: 'Good night' },
  11: {
    type: 'assistant',
    uuid: '1f2d4cf5-3c8d-4a4d-88c8-41bb18ba2fa2',
    timestamp: '2026-05-01T18:27:49.786Z',
    message: {
      id: '202605020227467800a89c4058491d',
      role: 'assistant',
      model: 'auto',
      content: [{
        type: 'tool_use',
        id: 'chatcmpl-tool-aea4a8099dc32836',
        name: 'Bash',
        input: { command: 'ls', description: 'List files in current directory' },
      }],
    },
    sessionId: 'c657a8f6-b0d0-472a-acd2-a368e9d94a71',
    entrypoint: 'cli',
  },
  13: {
    type: 'user',
    uuid: 'e8e21a34-5946-4d30-a71d-14e7558a99a2',
    timestamp: '2026-05-01T18:30:06.344Z',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'chatcmpl-tool-aea4a8099dc32836',
        content: '248bc65e result',
        is_error: false,
      }],
    },
    toolUseResult: { stdout: '248bc65e result', stderr: '' },
    sessionId: 'c657a8f6-b0d0-472a-acd2-a368e9d94a71',
    entrypoint: 'cli',
  },
};

const IDE_FIXTURE: Record<number, Record<string, unknown>> = {
  2: {
    type: 'session_meta',
    sessionId: 'a7eaeff7-f187-463f-bc66-304a7d76fa6e',
    uuid: 'b0172f61-4324-4caa-b9f5-64873f116b86',
    timestamp: '2026-05-01T18:09:26.898075Z',
    cwd: '/Users/lukechen/ai-agent-audit',
  },
  3: {
    type: 'user',
    sessionId: 'a7eaeff7-f187-463f-bc66-304a7d76fa6e',
    uuid: '4279a1bc-a6e2-4cae-a086-359d2051dd6d',
    timestamp: '2026-05-01T18:09:26.898536Z',
    cwd: '/Users/lukechen/ai-agent-audit',
    message: { role: 'user', content: 'woooo!' },
  },
  6: {
    type: 'progress',
    sessionId: 'a7eaeff7-f187-463f-bc66-304a7d76fa6e',
    uuid: 'c2a3b9fa-eb6f-4002-8b5e-f718f905de4d',
    timestamp: '2026-05-01T18:09:36.092556Z',
    cwd: '/Users/lukechen/ai-agent-audit',
  },
  26: {
    type: 'assistant',
    sessionId: 'a7eaeff7-f187-463f-bc66-304a7d76fa6e',
    uuid: '1be12cd5-8468-41b5-82cb-fbce2ee454a3',
    timestamp: '2026-05-01T18:24:26.751673Z',
    cwd: '/Users/lukechen/ai-agent-audit',
    message: {
      role: 'assistant',
      content: [{
        id: 'call_1c6e9e8b14254b9a9e3d64dc',
        input: { path: '/Users/lukechen/ai-agent-audit' },
        name: 'list_dir',
        type: 'tool_use',
      }],
    },
  },
  27: {
    type: 'user',
    sessionId: 'a7eaeff7-f187-463f-bc66-304a7d76fa6e',
    uuid: '8a17efb0-62d7-4e7b-b423-8cfea2c4e5ec',
    timestamp: '2026-05-01T18:24:26.751961Z',
    cwd: '/Users/lukechen/ai-agent-audit',
    message: {
      role: 'user',
      content: [{
        content: 'Contents of directory /Users/lukechen/ai-agent-audit:',
        is_error: false,
        tool_use_id: 'call_1c6e9e8b14254b9a9e3d64dc',
        type: 'tool_result',
      }],
    },
    toolUseResult: 'Contents of directory /Users/lukechen/ai-agent-audit:',
  },
};
