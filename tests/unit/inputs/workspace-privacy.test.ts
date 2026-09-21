import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexTranscriptInput } from '../../../src/inputs/codex-transcript/codex-transcript-input.js';
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
