import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  enrichQwenWorkCNMultimodal,
  extractQwenWorkCNToolResultPaths,
} from '../../../src/inputs/qwen-work-cn/qwen-work-cn-multimodal.js';
import { qwenWorkCNDefaultAllowedRootPaths } from '../../../src/inputs/qwen-work-cn/qwen-work-cn-trace-input.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { fakePathToUri } from '../multimodal/fake-uri.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fsSync.rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'pilot-qwen-work-cn-mm-'));
  tmpDirs.push(dir);
  return dir;
}

function writePng(dir: string, name: string, content = 'png-bytes'): string {
  const file = path.join(dir, name);
  fsSync.writeFileSync(file, Buffer.from(content));
  return file;
}

function entry(overrides: Partial<AgentActivityEntry> = {}): AgentActivityEntry {
  return {
    'event.id': 'e1',
    'event.name': 'other',
    'gen_ai.agent.type': 'qwen-work-cn',
    'gen_ai.session.id': 'sess',
    'gen_ai.turn.id': 'turn-1',
    'agent.qwenworkcn.cwd': '/work',
    ...overrides,
  } as AgentActivityEntry;
}

function textMessage(content: string): AgentActivityEntry {
  return entry({
    'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content }] }],
  } as Partial<AgentActivityEntry>);
}

function uriParts(value: unknown): Array<{ uri?: string }> {
  if (!Array.isArray(value)) return [];
  return value.filter(part => part && typeof part === 'object' && (part as { type?: string }).type === 'uri') as Array<{ uri?: string }>;
}

describe('qwen-work-cn multimodal', () => {
  it('reads the pasted image tag, including later attributes and several images', async () => {
    const dir = makeTempDir();
    const first = writePng(dir, 'a.png', 'one');
    const second = writePng(dir, 'b.png', 'two');
    const pasted = textMessage(
      `<user-pasted-image file="${first}" /> 看这个\n`
      + `<user-pasted-image file="${second}" source="local-path" source-version="1" ordinal="0" />`,
    );

    await enrichQwenWorkCNMultimodal([pasted], { uploadMode: 'input', pathToUri: fakePathToUri });

    const parts = (pasted['gen_ai.input.messages_delta'] as Array<{ parts: unknown[] }>)[0].parts;
    expect(uriParts(parts).map(part => part.uri)).toEqual(['oss://test/one', 'oss://test/two']);
    expect(pasted['gen_ai.input.multimodal_metadata_delta']).toEqual([
      { uri: 'oss://test/one', mime_type: 'image/png', modality: 'image' },
      { uri: 'oss://test/two', mime_type: 'image/png', modality: 'image' },
    ]);
  });

  it('leaves a bare filename and a reminder reference unchanged', async () => {
    const bare = textMessage('assets/hero.png');
    const reminder = textMessage('<system-reminder>@[image:base64:older]</system-reminder>');
    const beforeBare = JSON.stringify(bare);
    const beforeReminder = JSON.stringify(reminder);

    await enrichQwenWorkCNMultimodal([bare, reminder], { uploadMode: 'all', pathToUri: fakePathToUri });

    expect(JSON.stringify(bare)).toBe(beforeBare);
    expect(JSON.stringify(reminder)).toBe(beforeReminder);
  });

  it('takes Read file_path only from the Read tool call', async () => {
    const dir = makeTempDir();
    fsSync.mkdirSync(path.join(dir, 'picture'));
    const file = writePng(path.join(dir, 'picture'), 'upstream.jpg', 'read');
    const call = entry({
      'event.name': 'tool.call',
      'gen_ai.tool.name': 'Read',
      'gen_ai.tool.call.arguments': { file_path: 'picture/upstream.jpg' },
      'agent.qwenworkcn.cwd': dir,
    } as Partial<AgentActivityEntry>);
    const other = entry({
      'event.name': 'tool.call',
      'gen_ai.tool.name': 'Glob',
      'gen_ai.tool.call.arguments': { file_path: file },
    } as Partial<AgentActivityEntry>);
    const beforeOther = JSON.stringify(other);

    await enrichQwenWorkCNMultimodal([call, other], { uploadMode: 'output', pathToUri: fakePathToUri });

    expect(uriParts(call['gen_ai.tool.call.arguments']).map(part => part.uri)).toEqual(['oss://test/read']);
    expect(call['gen_ai.output.multimodal_metadata']).toEqual([
      { uri: 'oss://test/read', mime_type: 'image/jpeg', modality: 'image' },
    ]);
    expect(JSON.stringify(other)).toBe(beforeOther);
  });

  it('does not rewrite Read arguments in input mode', async () => {
    const dir = makeTempDir();
    const file = writePng(dir, 'a.png');
    const call = entry({
      'event.name': 'tool.call',
      'gen_ai.tool.name': 'Read',
      'gen_ai.tool.call.arguments': { file_path: file },
    } as Partial<AgentActivityEntry>);
    const before = JSON.stringify(call);

    await enrichQwenWorkCNMultimodal([call], { uploadMode: 'input', pathToUri: fakePathToUri });

    expect(JSON.stringify(call)).toBe(before);
  });

  it('reads media_read call files and result sources once', async () => {
    const dir = makeTempDir();
    const file = writePng(dir, 'pipeline.jpg', 'seen');
    const call = entry({
      'event.name': 'tool.call',
      'gen_ai.tool.name': 'mcp__qw-builtin__qwenwork_media_read',
      'gen_ai.tool.call.arguments': { files: [file, file] },
    } as Partial<AgentActivityEntry>);
    const result = entry({
      'event.name': 'tool.result',
      'gen_ai.tool.name': 'mcp__qw-builtin__qwenwork_media_read',
      'gen_ai.tool.call.result': JSON.stringify({
        success: true,
        data: {
          text: `caption ${file}`,
          files: [
            { source: file, kind: 'image', mimeType: 'image/jpeg' },
            { source: file, kind: 'image', mimeType: 'image/jpeg' },
            { source: path.join(dir, 'note.txt'), kind: 'text' },
          ],
        },
      }),
    } as Partial<AgentActivityEntry>);

    await enrichQwenWorkCNMultimodal([call, result], { uploadMode: 'all', pathToUri: fakePathToUri });

    expect(uriParts(call['gen_ai.tool.call.arguments'])).toHaveLength(1);
    expect(uriParts(result['gen_ai.tool.call.result'])).toHaveLength(1);
    expect(result['gen_ai.input.multimodal_metadata_delta']).toEqual([
      { uri: 'oss://test/seen', mime_type: 'image/jpeg', modality: 'image' },
    ]);
  });

  it('reads a completed media task and the present file once', async () => {
    const dir = makeTempDir();
    const file = writePng(dir, 'poster.jpg', 'poster');
    const pending = entry({
      'event.name': 'tool.result',
      'gen_ai.tool.name': 'mcp__qw-builtin__qwenwork_image_generate',
      'gen_ai.tool.call.result': JSON.stringify({ status: 'pending', task_id: 'media_1' }),
    } as Partial<AgentActivityEntry>);
    const waitCall = entry({
      'event.name': 'tool.call',
      'gen_ai.tool.name': 'mcp__qw-builtin__qwenwork_media_task',
      'gen_ai.tool.call.arguments': { action: 'wait', output_name: 'poster' },
    } as Partial<AgentActivityEntry>);
    const completed = entry({
      'event.name': 'tool.result',
      'gen_ai.tool.name': 'mcp__qw-builtin__qwenwork_media_task',
      'gen_ai.tool.call.result': JSON.stringify({ status: 'completed', files: [file] }),
    } as Partial<AgentActivityEntry>);
    const presentCall = entry({
      'event.name': 'tool.call',
      'gen_ai.tool.name': 'mcp__qw-builtin__qwenwork_file_present_files',
      'gen_ai.tool.call.arguments': { files: [{ file_path: file }] },
    } as Partial<AgentActivityEntry>);
    const presentResult = entry({
      'event.name': 'tool.result',
      'gen_ai.tool.name': 'mcp__qw-builtin__qwenwork_file_present_files',
      'gen_ai.tool.call.result': {
        artifacts: [{ filePath: file }],
        artifactPublication: { artifacts: [{ uri: file, metadata: { originalUri: file } }] },
      },
    } as Partial<AgentActivityEntry>);
    const beforePending = JSON.stringify(pending);
    const beforeWait = JSON.stringify(waitCall);

    await enrichQwenWorkCNMultimodal(
      [pending, waitCall, completed, presentCall, presentResult],
      { uploadMode: 'all', pathToUri: fakePathToUri },
    );

    expect(JSON.stringify(pending)).toBe(beforePending);
    expect(JSON.stringify(waitCall)).toBe(beforeWait);
    expect(uriParts(completed['gen_ai.tool.call.result'])).toHaveLength(1);
    expect(uriParts(presentCall['gen_ai.tool.call.arguments'])).toHaveLength(1);
    expect(uriParts(presentResult['gen_ai.tool.call.result'])).toHaveLength(1);
    const other = writePng(dir, 'other.jpg', 'other');
    expect(extractQwenWorkCNToolResultPaths(
      'mcp__qw-builtin__qwenwork_file_present_files',
      {
        artifacts: [{ filePath: file }],
        artifactPublication: { artifacts: [{ uri: other, metadata: { originalUri: other } }] },
      },
    )).toEqual([file]);
  });

  it('keeps the original field when pathToUri returns null or throws', async () => {
    const dir = makeTempDir();
    const outside = writePng(dir, 'outside.png', 'out');
    const missed = textMessage(`<user-pasted-image file="${outside}" />`);
    const beforeMissed = JSON.stringify(missed);

    await enrichQwenWorkCNMultimodal([missed], {
      uploadMode: 'all',
      pathToUri: async () => null,
    });

    expect(JSON.stringify(missed)).toBe(beforeMissed);

    const thrownDir = makeTempDir();
    const file = writePng(thrownDir, 'a.png');
    const pasted = textMessage(`<user-pasted-image file="${file}" />`);
    const original = (pasted['gen_ai.input.messages_delta'] as Array<{ parts: unknown[] }>)[0].parts;

    await enrichQwenWorkCNMultimodal([pasted], {
      uploadMode: 'all',
      pathToUri: async () => { throw new Error('disk'); },
    });

    expect((pasted['gen_ai.input.messages_delta'] as Array<{ parts: unknown[] }>)[0].parts).toEqual(original);
    expect(pasted['gen_ai.input.multimodal_metadata']).toBeUndefined();
  });

  it('does nothing when uploadMode is none', async () => {
    const dir = makeTempDir();
    const file = writePng(dir, 'a.png');
    const pasted = textMessage(`<user-pasted-image file="${file}" />`);
    const before = JSON.stringify(pasted);

    await enrichQwenWorkCNMultimodal([pasted], { uploadMode: 'none', pathToUri: fakePathToUri });

    expect(JSON.stringify(pasted)).toBe(before);
  });

  it('defaults the allowlist to the product directories', () => {
    const roots = qwenWorkCNDefaultAllowedRootPaths();
    expect(roots.some(root => root.endsWith(`${path.sep}.qwenworkcn${path.sep}workspace`) || root.endsWith('/.qwenworkcn/workspace'))).toBe(true);
    expect(roots.some(root => root.endsWith(`${path.sep}.qwenworkcn${path.sep}tmp`) || root.endsWith('/.qwenworkcn/tmp'))).toBe(true);
    expect(roots).toHaveLength(2);
  });
});
