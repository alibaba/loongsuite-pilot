import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspacePolicy, validateExcludedWorkspaces } from '../../../src/core/workspace-policy.js';

const dirs: string[] = [];
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-policy-')); dirs.push(dir); return dir; }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const event = (session: string, cwd?: string) => ({ 'gen_ai.agent.type': 'codex', 'gen_ai.session.id': session, ...(cwd ? { 'agent.codex.cwd': cwd } : {}) });

describe('workspace exclusions', () => {
  it('matches directories and descendants but not sibling prefixes or relative paths', () => {
    const root = path.join(temp(), 'private');
    const policy = new WorkspacePolicy([root]);
    expect(policy.excludes(root)).toBe(true);
    expect(policy.excludes(path.join(root, 'app', '..', 'other'))).toBe(true);
    expect(policy.excludes(`${root}-copy`)).toBe(false);
    expect(policy.excludes('private')).toBe(false);
  });
  it('resolves symlinks including non-existing descendants', () => {
    const dir = temp(); const root = path.join(dir, 'private'); const alias = path.join(dir, 'alias');
    fs.mkdirSync(root); fs.symlinkSync(root, alias, 'junction');
    expect(new WorkspacePolicy([root]).excludes(path.join(alias, 'not-created'))).toBe(true);
    expect(new WorkspacePolicy([alias]).excludes(root)).toBe(true);
  });
  it('allows unknown workspace and never scans prompt, tool paths, or inferred git root', () => {
    const root = temp(); const policy = new WorkspacePolicy([root]);
    expect(policy.allows({ ...event('unknown'), 'gen_ai.input.messages': root, 'workspace.current_root': root, 'gen_ai.tool.call.arguments': { path: root } })).toBe(true);
    expect(policy.allows(event('public', path.join(os.tmpdir(), 'public')))).toBe(true);
  });
  it('blocks any explicit workspace root including JSON-encoded arrays', () => {
    const root = temp(); const policy = new WorkspacePolicy([root]);
    expect(policy.allows({ ...event('multi'), 'agent.cursor.workspace_roots': JSON.stringify(['/public', root]) })).toBe(false);
    expect(policy.allows({ workspace_roots: ['/public', root] })).toBe(false);
  });
  it('remembers blocked sessions across records, restarts and concurrent hook processes', () => {
    const dir = temp(); const root = path.join(dir, 'private'); const state = path.join(dir, 'state');
    const collector = new WorkspacePolicy([root], state);
    const hook = new WorkspacePolicy([root], state);
    expect(collector.allows(event('one'))).toBe(true);
    expect(hook.allows(event('one', root))).toBe(false);
    expect(collector.allows(event('one', '/public'))).toBe(false);
    expect(collector.allows(event('two'))).toBe(true);
    expect(new WorkspacePolicy([root], state).allows(event('one'))).toBe(false);
    expect(new WorkspacePolicy([], state).allows(event('one'))).toBe(true);
    expect(collector.allows({ ...event('one'), 'gen_ai.agent.type': 'cursor' })).toBe(true);
    expect(fs.readdirSync(state).join()).not.toContain(root);
  });
  it('preflights batches before letting earlier content from a blocked session escape', () => {
    const root = temp(); const policy = new WorkspacePolicy([root]);
    const unknown = event('late'); const denied = event('late', root); const allowed = event('other');
    expect(policy.filter([unknown, allowed, denied])).toEqual([allowed]);
  });
  it('rejects malformed rules instead of silently disabling privacy', () => {
    expect(() => validateExcludedWorkspaces('private')).toThrow();
    expect(() => validateExcludedWorkspaces(['relative'])).toThrow();
    expect(() => validateExcludedWorkspaces([null])).toThrow();
    expect(validateExcludedWorkspaces(undefined)).toEqual([]);
  });
});

it('isolates marker write failures, retries after recovery, and does not drop public events', () => {
  vi.useFakeTimers();
  const warning = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const root = temp(); const state = path.join(root, 'blocked-state');
  fs.writeFileSync(state, 'a pre-existing file prevents directory creation');
  const policy = new WorkspacePolicy(['/private-project'], state);
  const publicEntry = event('public', '/public-project');
  expect(policy.filter([event('private', '/private-project'), publicEntry])).toEqual([publicEntry]);
  expect(policy.allows(event('private'))).toBe(false);
  expect(warning).toHaveBeenCalledOnce();
  expect(String(warning.mock.calls[0][0])).not.toContain(root);
  fs.unlinkSync(state);
  vi.advanceTimersByTime(6000);
  policy.filter([publicEntry]);
  expect(new WorkspacePolicy(['/private-project'], state).allows(event('private'))).toBe(false);
});

it('shares identified sessions across file pipelines while isolating other agents and anonymous sources', () => {
  const root = temp(); const policy = new WorkspacePolicy([root], path.join(temp(), 'markers'));
  expect(policy.allows(event('same-session', root), 'file:first')).toBe(false);
  expect(policy.allows(event('same-session'), 'file:second')).toBe(false);
  expect(policy.allows({ ...event('same-session'), 'gen_ai.agent.type': 'cursor' }, 'file:second')).toBe(true);
  expect(policy.allows({ session_id: 'same-session' }, 'file:second')).toBe(true);
});

// Collector configuration is intentionally a startup snapshot, not live reload.
it('applies an edited rule list when the collector policy is recreated on restart', () => {
  const rules = ['/first-private'];
  const running = new WorkspacePolicy(rules);
  rules.push('/new-private');
  expect(running.allows(event('new', '/new-private'))).toBe(true);
  const restarted = new WorkspacePolicy(rules);
  expect(restarted.allows(event('new', '/new-private'))).toBe(false);
});
