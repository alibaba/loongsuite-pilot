import { describe, expect, it } from 'vitest';
import type { AgentDefinition } from '../../../src/types/index.js';
import { parseInjectArgs, planEagerDeploys, isGateEnabled } from '../../../src/inject-hooks.js';
import { isAgentGatedEnabled } from '../../../src/deployment/deploy-command.js';

/**
 * inject-hooks runs on the agent's startup critical path, spawned by
 * k8s-preload.cjs before the workload's first module executes. Two properties
 * matter more than anything about its output:
 *
 *  1. A bad agent id must never reduce collection. The id list comes from a K8s
 *     label, so a typo is a matter of when, not if — and the daemon deploys
 *     everything it detects moments later regardless.
 *  2. It must never refuse to run because of an argument it does not know. The
 *     caller is a shell script and an operator-injected env var, both of which
 *     can be older or newer than this binary.
 */

function def(over: Partial<AgentDefinition> & { id: string }): AgentDefinition {
  return {
    displayName: over.id,
    deployMode: 'hook',
    detection: { paths: [], commands: [] },
    ...over,
  } as AgentDefinition;
}

const DEFS = [
  def({ id: 'claude-code', deployMode: 'hook' }),
  def({ id: 'openclaw', deployMode: 'plugin-inject' }),
  def({ id: 'agentteams-codex-local-runtime', deployMode: 'plugin-probe' }),
  def({ id: 'hermes-agent', deployMode: 'directory-plugin' }),
  def({ id: 'dsh', deployMode: 'dsh-yaml-patch' }),
  def({ id: 'qoder-jetbrains', deployMode: 'detection-only' }),
];

describe('parseInjectArgs', () => {
  it('splits, trims and de-duplicates the id list', () => {
    const args = parseInjectArgs(['--agents=claude-code, openclaw ,claude-code,,']);
    expect(args.agents).toEqual(['claude-code', 'openclaw']);
  });

  it('yields an empty list for an empty value rather than throwing', () => {
    expect(parseInjectArgs(['--agents=']).agents).toEqual([]);
    expect(parseInjectArgs(['--agents=  ,  ']).agents).toEqual([]);
  });

  it('reads the dir overrides the callers pass', () => {
    const args = parseInjectArgs([
      '--agents=claude-code',
      '--data-dir=/mnt/pilot/data',
      '--pilot-dir=/mnt/pilot',
    ]);
    expect(args.dataDir).toBe('/mnt/pilot/data');
    expect(args.pilotDir).toBe('/mnt/pilot');
  });

  // Deliberately the opposite of deploy-command's parseArgs, which throws on an
  // unrecognized option. That throw guards an image build; here refusing to start
  // over a stray argument would mean total loss of eager injection.
  //
  // This is also the safety net for having no flag aliases: `--agents` is the one
  // spelling, and anything else — including the `--agent=` that start.sh accepts
  // from its own callers and normalises away — degrades to a warning rather than
  // an abort.
  it('collects unknown flags instead of throwing, and still parses the rest', () => {
    const args = parseInjectArgs(['--agents=claude-code', '--nope', '--agent=x']);
    expect(args.agents).toEqual(['claude-code']);
    expect(args.unknownFlags).toEqual(['--nope', '--agent=x']);
  });
});

describe('planEagerDeploys', () => {
  it('plans hook and plugin-inject agents for eager deployment', () => {
    const plan = planEagerDeploys(DEFS, ['claude-code', 'openclaw']);
    expect(plan.map(p => p.action)).toEqual(['deploy', 'deploy']);
  });

  // plugin-probe's deploy() stops the running worker, runs the old package's
  // uninstall.sh and re-extracts a tarball, and its needsDeploy() can hit the
  // network. None of that may happen in front of a business process.
  it('defers plugin-probe rather than deploying it eagerly', () => {
    const plan = planEagerDeploys(DEFS, ['agentteams-codex-local-runtime']);
    expect(plan).toEqual([
      { agentId: 'agentteams-codex-local-runtime', action: 'deferred', deployMode: 'plugin-probe' },
    ]);
  });

  it('defers the other modes not yet exercised on this path', () => {
    const plan = planEagerDeploys(DEFS, ['hermes-agent', 'dsh', 'qoder-jetbrains']);
    expect(plan.map(p => p.action)).toEqual(['deferred', 'deferred', 'deferred']);
  });

  it('reports an unknown id without disturbing the ids it does know', () => {
    const plan = planEagerDeploys(DEFS, ['clade-code', 'claude-code']);
    expect(plan).toEqual([
      { agentId: 'clade-code', action: 'unknown-id' },
      { agentId: 'claude-code', action: 'deploy', deployMode: 'hook' },
    ]);
  });

  it('plans nothing when every id is unknown, and reports each one', () => {
    const plan = planEagerDeploys(DEFS, ['nope-1', 'nope-2']);
    expect(plan.every(p => p.action === 'unknown-id')).toBe(true);
    expect(plan).toHaveLength(2);
  });

  it('preserves the caller-supplied order', () => {
    const plan = planEagerDeploys(DEFS, ['openclaw', 'claude-code']);
    expect(plan.map(p => p.agentId)).toEqual(['openclaw', 'claude-code']);
  });
});

/**
 * No id list is the common case, not a missing argument: the list comes from an
 * optional K8s label. Sweeping keeps eager injection working without the label,
 * which is what demotes the operator-side plumbing from prerequisite to
 * optimisation. detect() then decides, exactly as it does for the daemon.
 */
describe('planEagerDeploys with no requested ids (sweep)', () => {
  it('plans every eager-safe definition', () => {
    const plan = planEagerDeploys(DEFS, []);
    expect(plan.map(p => p.agentId)).toEqual(['claude-code', 'openclaw']);
    expect(plan.every(p => p.action === 'deploy')).toBe(true);
  });

  // `deferred` answers "you asked for this and here is why it is not happening
  // now". With nobody asking, the same entries become one warning per
  // non-eager definition in every Pod's log — six today, for work no caller
  // requested. Silence is the correct output, so this asserts absence.
  it('emits no deferred or unknown-id entries', () => {
    const plan = planEagerDeploys(DEFS, []);
    expect(plan.some(p => p.action === 'deferred')).toBe(false);
    expect(plan.some(p => p.action === 'unknown-id')).toBe(false);
  });

  // The destructive mode must be unreachable by omission as well as by request:
  // plugin-probe's deploy() stops a worker, runs uninstall.sh and re-extracts a
  // tarball. Sweeping is the path that runs without anyone opting in, so this is
  // the more important of the two exclusion tests.
  it('never sweeps plugin-probe in, even though no caller excluded it', () => {
    const plan = planEagerDeploys(DEFS, []);
    expect(plan.map(p => p.deployMode)).not.toContain('plugin-probe');
  });

  it('plans nothing when no definition uses an eager-safe mode', () => {
    const plan = planEagerDeploys(DEFS.filter(d => d.deployMode === 'plugin-probe'), []);
    expect(plan).toEqual([]);
  });

  // parseInjectArgs turns `--agents=` and `--agents=  ,  ` into [], so the two
  // spellings of "no ids" must reach the same plan as omitting the flag.
  it('treats an explicitly empty --agents the same as omitting it', () => {
    const viaFlag = planEagerDeploys(DEFS, parseInjectArgs(['--agents=  ,  ']).agents);
    expect(viaFlag).toEqual(planEagerDeploys(DEFS, []));
  });
});

/**
 * The eager path re-decides the enabled gate instead of importing
 * isAgentGatedEnabled (this entry must stay a self-contained bundle), so the two
 * implementations must not drift: a disabled agent that eager-injects anyway
 * keeps firing its hook until the daemon's next undeploy pass — admission
 * control silently off. Pin them against the same matrix.
 */
describe('isGateEnabled parity with deploy-command.isAgentGatedEnabled', () => {
  const ids = ['claude-code', 'openclaw', 'hermes-agent'];
  const gates: Array<Record<string, { enabled?: boolean }> | undefined> = [
    undefined,
    {},
    { 'claude-code': { enabled: true } },
    { 'claude-code': { enabled: false } },
    { openclaw: { enabled: false } },
    { 'claude-code': { enabled: false }, openclaw: { enabled: false }, 'hermes-agent': { enabled: false } },
    { 'claude-code': {} },
  ];

  for (const gate of gates) {
    for (const id of ids) {
      it(`agrees for gate=${JSON.stringify(gate)} id=${id}`, () => {
        const config = { agents: gate } as never as Parameters<typeof isAgentGatedEnabled>[0];
        expect(isGateEnabled(gate, id)).toBe(isAgentGatedEnabled(config, id));
      });
    }
  }
});
