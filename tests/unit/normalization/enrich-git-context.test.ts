import { describe, it, expect, vi, beforeEach } from 'vitest';

const inferGitContext = vi.fn();
vi.mock('../../../src/utils/git-context.js', () => ({
  inferGitContext: (...args: unknown[]) => inferGitContext(...args),
}));

import {
  enrichCanonicalEntriesWithGit,
  enrichCanonicalEntryWithGit,
} from '../../../src/normalization/enrich-git-context.js';

describe('enrichCanonicalEntryWithGit', () => {
  beforeEach(() => {
    inferGitContext.mockReset();
  });

  it('sets workspace.path from agent.<ns>.cwd even when the dir is not a git repo', async () => {
    inferGitContext.mockResolvedValue({});
    const entry: Record<string, unknown> = {};
    const record = { 'agent.opencode.cwd': '/Users/foo/not-a-repo' };

    await enrichCanonicalEntryWithGit(entry, record, 'opencode');

    expect(entry['workspace.path']).toBe('/Users/foo/not-a-repo');
    expect(entry['workspace.current_root']).toBeUndefined();
    expect(entry['git.repo']).toBeUndefined();
  });

  it('sets both workspace.path (cwd) and workspace.current_root (git root) in a git repo', async () => {
    inferGitContext.mockResolvedValue({
      repo: 'org/proj',
      branch: 'main',
      domain: 'github.com',
      root: '/Users/foo/proj',
    });
    const entry: Record<string, unknown> = {};
    const record = { 'agent.opencode.cwd': '/Users/foo/proj/src' };

    await enrichCanonicalEntryWithGit(entry, record, 'opencode');

    expect(entry['workspace.path']).toBe('/Users/foo/proj/src');
    expect(entry['workspace.current_root']).toBe('/Users/foo/proj');
    expect(entry['git.repo']).toBe('org/proj');
    expect(entry['git.branch']).toBe('main');
  });

  it('accepts Windows absolute cwd paths for git enrichment', async () => {
    inferGitContext.mockResolvedValue({
      repo: 'org/win-proj',
      branch: 'feature/windows',
      domain: 'github.com',
      root: 'C:\\Users\\foo\\proj',
    });
    const entry: Record<string, unknown> = {};
    const record = { 'agent.opencode.cwd': 'C:\\Users\\foo\\proj\\src' };

    await enrichCanonicalEntryWithGit(entry, record, 'opencode');

    expect(inferGitContext).toHaveBeenCalledWith('C:\\Users\\foo\\proj\\src');
    expect(entry['workspace.path']).toBe('C:\\Users\\foo\\proj\\src');
    expect(entry['workspace.current_root']).toBe('C:\\Users\\foo\\proj');
    expect(entry['git.repo']).toBe('org/win-proj');
  });

  it('accepts Windows absolute workspace roots when cwd is absent', async () => {
    inferGitContext.mockResolvedValue({ root: '\\\\server\\share\\repo' });
    const entry: Record<string, unknown> = {};
    const record = {
      'agent.opencode.workspace_roots': JSON.stringify(['\\\\server\\share\\repo']),
    };

    await enrichCanonicalEntryWithGit(entry, record, 'opencode');

    expect(inferGitContext).toHaveBeenCalledWith('\\\\server\\share\\repo');
    expect(entry['workspace.path']).toBe('\\\\server\\share\\repo');
    expect(entry['workspace.current_root']).toBe('\\\\server\\share\\repo');
  });

  it('does not run git inference when git.repo and git.branch are already present, but still sets workspace.path', async () => {
    const entry: Record<string, unknown> = { 'git.repo': 'org/proj', 'git.branch': 'main' };
    const record = { 'agent.opencode.cwd': '/Users/foo/proj' };

    await enrichCanonicalEntryWithGit(entry, record, 'opencode');

    expect(inferGitContext).not.toHaveBeenCalled();
    expect(entry['workspace.path']).toBe('/Users/foo/proj');
  });

  it('does not overwrite an existing workspace.path', async () => {
    inferGitContext.mockResolvedValue({});
    const entry: Record<string, unknown> = { 'workspace.path': '/already/set' };
    const record = { 'agent.opencode.cwd': '/Users/foo/other' };

    await enrichCanonicalEntryWithGit(entry, record, 'opencode');

    expect(entry['workspace.path']).toBe('/already/set');
  });

  it('ignores non-absolute cwd (no workspace.path set)', async () => {
    const entry: Record<string, unknown> = {};
    const record = { 'agent.opencode.cwd': 'relative/dir' };

    await enrichCanonicalEntryWithGit(entry, record, 'opencode');

    expect(entry['workspace.path']).toBeUndefined();
    expect(inferGitContext).not.toHaveBeenCalled();
  });

  it.each([
    ['qoder-work', 'agent.qoderwork.cwd'],
    ['qoder-work-cn', 'agent.qoderwork.cwd'],
    ['qwen-work-cn', 'agent.qwenworkcn.cwd'],
    ['qoder-cn', 'agent.qoder.cwd'],
    ['cursor-cli', 'agent.cursor_cli.cwd'],
  ])('resolves %s producer namespace aliases', async (namespace, cwdKey) => {
    inferGitContext.mockResolvedValue({});
    const entry: Record<string, unknown> = {};

    await enrichCanonicalEntryWithGit(entry, { [cwdKey]: '/workspace/aliased' }, namespace);

    expect(entry['workspace.path']).toBe('/workspace/aliased');
    expect(inferGitContext).toHaveBeenCalledWith('/workspace/aliased');
  });

  it('last-mile enriches entries from agent type or an existing canonical workspace path', async () => {
    inferGitContext.mockResolvedValueOnce({
      repo: 'org/codex-project',
      branch: 'feature/codex',
      domain: 'github.com',
      root: '/workspace/codex-project',
    }).mockResolvedValueOnce({});
    const entries: Record<string, unknown>[] = [
      {
        'gen_ai.agent.type': 'codex',
        'agent.codex.cwd': '/workspace/codex-project/src',
      },
      {
        'gen_ai.agent.type': 'cursor',
        'agent.cursor.cwd': '/workspace/cursor-project',
        'workspace.path': '/workspace/cursor-project',
      },
    ];

    await enrichCanonicalEntriesWithGit(entries);

    expect(entries[0]).toMatchObject({
      'workspace.path': '/workspace/codex-project/src',
      'workspace.current_root': '/workspace/codex-project',
      'git.repo': 'org/codex-project',
      'git.branch': 'feature/codex',
      'git.domain': 'github.com',
    });
    expect(inferGitContext).toHaveBeenNthCalledWith(1, '/workspace/codex-project/src');
    expect(inferGitContext).toHaveBeenNthCalledWith(2, '/workspace/cursor-project');
  });
});
