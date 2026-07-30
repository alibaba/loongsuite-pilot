import { describe, it, expect, vi, beforeEach } from 'vitest';

const inferGitContext = vi.fn();
vi.mock('../../../src/utils/git-context.js', () => ({
  inferGitContext: (...args: unknown[]) => inferGitContext(...args),
}));

import { enrichCanonicalEntryWithGit } from '../../../src/normalization/enrich-git-context.js';

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
});
