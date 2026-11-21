import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
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
  it.skipIf(process.platform === 'win32')('matches the lexical and physical roots of a symlink followed by a parent segment', () => {
    const dir = temp();
    const lexicalRoot = path.join(dir, 'lexical');
    const physicalRoot = path.join(dir, 'physical');
    const target = path.join(physicalRoot, 'target');
    const alias = path.join(lexicalRoot, 'link');
    fs.mkdirSync(lexicalRoot);
    fs.mkdirSync(target, { recursive: true });
    fs.symlinkSync(target, alias);
    const aliasParent = `${alias}${path.sep}..`;
    expect(fs.realpathSync.native(aliasParent)).toBe(fs.realpathSync.native(physicalRoot));
    for (const excluded of [lexicalRoot, physicalRoot]) {
      const policy = new WorkspacePolicy([excluded]);
      expect(policy.excludes(aliasParent)).toBe(true);
      expect(policy.excludes(`${aliasParent}${path.sep}missing`)).toBe(true);
    }
    const policy = new WorkspacePolicy([aliasParent]);
    expect(policy.excludes(lexicalRoot)).toBe(true);
    expect(policy.excludes(physicalRoot)).toBe(true);
    expect(policy.excludes(path.join(dir, 'public'))).toBe(false);
    const alternate = path.join(dir, 'alternate');
    fs.symlinkSync(lexicalRoot, alternate);
    expect(policy.excludes(path.join(alternate, 'missing'))).toBe(true);
    const alternateParent = `${path.join(alternate, 'link')}${path.sep}..`;
    const lexicalPolicy = new WorkspacePolicy([lexicalRoot]);
    expect(lexicalPolicy.excludes(alternateParent)).toBe(true);
    expect(lexicalPolicy.excludes(`${alternateParent}${path.sep}missing`)).toBe(true);
    vi.spyOn(os, 'homedir').mockReturnValue(lexicalRoot);
    expect(new WorkspacePolicy([physicalRoot]).excludes('~/link/..')).toBe(true);
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
  it('honors blocked session markers written with a lexical policy fingerprint', () => {
    const dir = temp();
    const root = path.join(dir, 'private');
    const configured = `${root}${path.sep}unused${path.sep}..`;
    const state = path.join(dir, 'state');
    const legacyRoot = process.platform === 'win32' ? root.toLowerCase() : root;
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const legacyDirectory = path.join(state, hash(JSON.stringify([legacyRoot])));
    fs.mkdirSync(legacyDirectory, { recursive: true });
    fs.writeFileSync(path.join(legacyDirectory, hash('codex\0legacy-session')), '');
    const policy = new WorkspacePolicy([configured], state);
    expect(policy.allows(event('legacy-session'))).toBe(false);
    expect(policy.allows(event('new-session'))).toBe(true);
    expect(new WorkspacePolicy([root], state).allows(event('legacy-session'))).toBe(false);
  });
  it.skipIf(process.platform === 'win32')('writes alias rules to their own durable marker namespace', () => {
    const dir = temp();
    const lexical = path.join(dir, 'lexical');
    const physical = path.join(dir, 'physical');
    const target = path.join(physical, 'child');
    const link = path.join(lexical, 'link');
    const aliasParent = `${link}${path.sep}..`;
    const state = path.join(dir, 'state');
    const otherRule = path.join(dir, 'other');
    fs.mkdirSync(lexical);
    fs.mkdirSync(target, { recursive: true });
    fs.symlinkSync(target, link);
    const policy = new WorkspacePolicy([aliasParent, otherRule], state);
    expect(policy.allows(event('alias-only', physical))).toBe(false);
    const narrower = new WorkspacePolicy([lexical, otherRule], state);
    expect(narrower.excludes(physical)).toBe(false);
    expect(narrower.allows(event('alias-only', physical))).toBe(true);
    fs.unlinkSync(link);
    const restarted = new WorkspacePolicy([otherRule, aliasParent], state);
    expect(restarted.excludes(physical)).toBe(false);
    expect(restarted.allows(event('alias-only'))).toBe(false);
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
