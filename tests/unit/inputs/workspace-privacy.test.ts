import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexTranscriptInput } from '../../../src/inputs/codex-transcript/codex-transcript-input.js';
import { extractCodexTranscriptMeta } from '../../../src/inputs/codex-transcript/codex-transcript-extractor.js';
import { StateStore } from '../../../src/checkpoints/state-store.js';
import { WorkspacePolicy } from '../../../src/core/workspace-policy.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });
describe('workspace privacy before Codex attachments', () => {
  it('does not call the uploader for blocked workspaces or a subsequently switched session', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-privacy-')); roots.push(root);
    const blobToUri = vi.fn().mockReturnValue(null);
    const input = new CodexTranscriptInput({
      stateStore: new StateStore(path.join(root, 'state.json')),
      multimodal: { enabled: true, uploadMode: 'all', processor: { blobToUri } as any },
    });
    input.setWorkspacePolicy(new WorkspacePolicy([root]));
    const params = { reuseKey: 'image', data: 'aGVsbG8=', mimeType: 'image/png' };
    const transcript = path.join(root, 'rollout-2026-09-21T00-00-00-12345678-1234-1234-1234-123456789abc.jsonl');
    (input as any).blobToUri(transcript, root)(params);
    (input as any).blobToUri(transcript, '/public')(params);
    expect(blobToUri).not.toHaveBeenCalled();
    (input as any).blobToUri(path.join(root, 'another-session.jsonl'))(params);
    expect(blobToUri).toHaveBeenCalledOnce();
  });
});

it('keeps a blocked child attachment private after a text-only turn and cwd change without blocking its parent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-privacy-')); roots.push(root);
  const fixture = path.resolve('tests/fixtures/codex-subagent/rollout-2026-08-07T10-00-04-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl');
  const meta = extractCodexTranscriptMeta(JSON.parse(fs.readFileSync(fixture, 'utf8').split('\n')[0]!))!;
  expect(meta.threadId).not.toBe(meta.rootSessionId);
  const upload = vi.fn().mockReturnValue(null);
  const input = new CodexTranscriptInput({
    stateStore: new StateStore(path.join(root, 'state.json')),
    multimodal: { enabled: true, uploadMode: 'all', processor: { blobToUri: upload } as any },
  });
  const policy = new WorkspacePolicy([root]);
  input.setWorkspacePolicy(policy);
  (input as any).transcriptMetaByPath.set(fixture, meta);
  // The first turn has only text: only the event filter records the exclusion.
  const childEvent = { 'gen_ai.session.id': meta.threadId, 'gen_ai.agent.type': input.agentType, cwd: root };
  expect(policy.filter([childEvent])).toEqual([]);
  const params = { data: 'aGVsbG8=', mimeType: 'image/png' };
  (input as any).blobToUri(fixture, '/public')(params);
  expect(upload).not.toHaveBeenCalled();
  expect(policy.filter([{ ...childEvent, cwd: '/public' }])).toEqual([]);
  // Sharing a root session must not incorrectly suppress an allowed parent.
  const parentPath = path.join(root, 'parent.jsonl');
  (input as any).transcriptMetaByPath.set(parentPath, { ...meta, threadId: meta.rootSessionId });
  (input as any).blobToUri(parentPath, '/public')(params);
  expect(upload).toHaveBeenCalledOnce();
});
