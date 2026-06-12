import { describe, expect, it } from 'vitest';
import { normalizeSourceContext, sourceFieldsFromContext } from '../../../src/normalization/source-context.js';

describe('source context normalization', () => {
  it('normalizes repo, branch, and current root from cwd plus multiple roots', () => {
    const context = normalizeSourceContext({
      repo: 'https://github.com/example-org/loongsuite-pilot.git',
      branch: 'feature/batch',
      cwd: '/Users/yutao/workspace/sls/loongsuite-pilot/src',
      workspaceRoots: ['/Users/yutao/workspace', '/Users/yutao/workspace/sls/loongsuite-pilot'],
    });

    expect(context).toEqual({
      repo: 'example-org/loongsuite-pilot',
      branch: 'feature/batch',
      currentRoot: '/Users/yutao/workspace/sls/loongsuite-pilot',
    });
  });

  it('selects current root from absolute tool paths when cwd is unavailable', () => {
    const context = normalizeSourceContext({
      workspaceRoots: ['/repo-a', '/repo-b'],
      absolutePaths: ['/repo-b/src/index.ts'],
    });

    expect(context.currentRoot).toBe('/repo-b');
  });

  it('does not promote raw cwd to current root without workspace roots', () => {
    const context = normalizeSourceContext({
      cwd: '/repo/subdir',
    });

    expect(context.currentRoot).toBeUndefined();
  });

  it('projects normalized source fields without standardizing raw cwd/root evidence', () => {
    const fields = sourceFieldsFromContext({
      repo: 'sls/loongsuite-pilot',
      branch: 'main',
      currentRoot: '/repo',
    });

    expect(fields).toEqual({
      'git.repo': 'sls/loongsuite-pilot',
      'git.branch': 'main',
      'workspace.current_root': '/repo',
    });
  });
});
