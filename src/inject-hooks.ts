// inject-hooks — deploy the agents present in this container synchronously,
// ahead of the daemon. `--agents` narrows the candidate set; without it every
// eager-safe definition is detected, exactly as the daemon would.
//
// Why this exists as its own entry point rather than a daemon subcommand:
// under the K8s auto-inject flow the business container is started with
// NODE_OPTIONS="--require .../k8s-preload.cjs", and that preload can only
// *spawn* the daemon, not wait for it — a `--require` hook is synchronous and
// cannot await. The daemon then needs 1-3s of cold start (bundle load, native
// modules, flusher setup) before deployAll() writes hooks into the agent's
// settings. An agent that reads its settings inside that window runs
// uninstrumented, and nothing reports an error: the telemetry is simply absent.
// Short-lived Jobs (`claude -p "..."`) can lose their entire run that way.
//
// So the preload spawnSync()s this entry *before* it spawns the daemon. This is
// a separate, self-contained CJS bundle (build.mjs) so that starting it costs a
// bare node startup instead of the daemon's full module graph.
//
// It deliberately reuses HookStrategy/PluginInjectStrategy verbatim instead of
// reimplementing injection synchronously. The hookCommand string those produce
// must match the daemon's byte for byte, because the daemon's later pass asks
// `isHookInstalled` — a one-character divergence reads as "not installed" and
// appends a SECOND hook entry, making every event fire twice. Sharing the code
// makes that impossible by construction rather than by review.
import * as path from 'node:path';
import { AgentDefLoader } from './deployment/agent-def-loader.js';
import { HookManager } from './hooks/hook-manager.js';
import { HookStrategy } from './deployment/hook-strategy.js';
import { PluginInjectStrategy } from './deployment/plugin-inject-strategy.js';
import { resolveHome } from './utils/fs-utils.js';
import { resolveDataDir } from './utils/data-dir.js';
import type { AgentDefinition } from './types/deployment.js';

// This file is always bundled as CJS (build.mjs), so __dirname is guaranteed.
const __inject_dirname = __dirname;

/**
 * Modes safe to deploy eagerly, on the agent's startup critical path.
 *
 * `plugin-probe` is excluded on purpose: its deploy() stops the running worker,
 * runs the previous package's uninstall.sh and re-extracts a tarball
 * (plugin-probe-strategy.ts), and its needsDeploy() can do network I/O. None of
 * that belongs in front of a business process. The four agentteams-* defs that
 * use it also carry empty detection blocks, so they never deploy through this
 * path anyway — they come up via LocalWorkerActivationService.
 *
 * `directory-plugin`, `dsh-yaml-patch` and `detection-only` are simply deferred
 * to the daemon for now; nothing about them is unsafe, they just have not been
 * exercised on this path.
 */
const EAGER_DEPLOY_MODES = new Set(['hook', 'plugin-inject']);

export interface InjectArgs {
  agents: string[];
  dataDir?: string;
  pilotDir?: string;
  unknownFlags: string[];
}

export type EagerAction = 'deploy' | 'deferred' | 'unknown-id';

export interface EagerPlanEntry {
  agentId: string;
  action: EagerAction;
  deployMode?: string;
}

/**
 * Split a comma-separated id list: trim, drop empties, de-duplicate.
 * Mirrors splitIds() in deploy-command.ts, plus the dedupe.
 */
function splitIds(raw: string): string[] {
  return [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))];
}

/**
 * Parse argv.
 *
 * `--agents` matches the installers' existing flag (deploy/installer.sh), so the
 * repo has one name for "which agents am I talking about" rather than several.
 * It is optional: absent or empty means "detect them all" (planEagerDeploys),
 * which is why an empty value is not an error here.
 * There are deliberately no aliases: the only two callers are start.sh and
 * k8s-preload.cjs, both of which ship in the same payload built by the same
 * assemble-payload.sh run, so they can never be a version behind this binary.
 * (start.sh does still accept `--agent=` for its own callers — the committed Job
 * example passes it — but it normalises that into `--agents=` before calling us.)
 *
 * Unknown flags are collected and reported, never thrown on — the deliberate
 * opposite of deploy-command.ts, which throws on an unrecognized option. That
 * throw is right for a build-time gate you want to fail loudly; here refusing to
 * start over a stray argument would mean total loss of eager injection, which is
 * precisely the silent gap this entry point exists to close.
 */
export function parseInjectArgs(argv: string[]): InjectArgs {
  const out: InjectArgs = { agents: [], unknownFlags: [] };
  for (const arg of argv) {
    if (arg.startsWith('--agents=')) {
      out.agents = splitIds(arg.slice('--agents='.length));
    } else if (arg.startsWith('--data-dir=')) {
      out.dataDir = arg.slice('--data-dir='.length);
    } else if (arg.startsWith('--pilot-dir=')) {
      out.pilotDir = arg.slice('--pilot-dir='.length);
    } else if (arg.startsWith('--')) {
      out.unknownFlags.push(arg);
    }
  }
  return out;
}

/**
 * Decide what to do with each requested id, given the loaded definitions.
 *
 * An empty `requestedIds` means "nobody told us which agents to expect" — the
 * common case, since the id list comes from an optional K8s label. We then plan
 * every eager-safe definition and let detect() decide, which is exactly what the
 * daemon does moments later. Detection is the same detectAgent() call in both
 * paths and is cheap (stat misses are free; the cost is ~14ms per `which`, ~9 of
 * them, so ~130ms worst case in a container with nothing installed). Paying that
 * makes eager injection work without the label, which in turn makes the
 * operator-side label plumbing a pure optimisation rather than a requirement.
 *
 * Sweep mode deliberately emits no `deferred` entries. `deferred` answers "you
 * asked for this agent and here is why it is not being done now"; when nobody
 * asked, the same lines are six warnings per Pod about work no one requested.
 *
 * Note what neither mode does: derive the deploy set from the requested list.
 * Requested ids only ever select a subset of definitions that already exist, so
 * an unrecognized id yields a diagnostic and nothing else — the daemon still
 * deploys every agent it detects. Contrast collectUnmet() in deploy-command.ts,
 * which turns the same "unknown id" input into a fatal exit: that is a build-time
 * assertion about a promise the caller made, this is a runtime hint that is
 * allowed to be wrong. Do not unify them.
 */
export function planEagerDeploys(defs: AgentDefinition[], requestedIds: string[]): EagerPlanEntry[] {
  if (requestedIds.length === 0) {
    return defs
      .filter(def => EAGER_DEPLOY_MODES.has(def.deployMode))
      .map(def => ({ agentId: def.id, action: 'deploy' as const, deployMode: def.deployMode }));
  }

  const byId = new Map(defs.map(def => [def.id, def]));
  return requestedIds.map(agentId => {
    const def = byId.get(agentId);
    if (!def) return { agentId, action: 'unknown-id' as const };
    if (!EAGER_DEPLOY_MODES.has(def.deployMode)) {
      return { agentId, action: 'deferred' as const, deployMode: def.deployMode };
    }
    return { agentId, action: 'deploy' as const, deployMode: def.deployMode };
  });
}

function warn(msg: string): void {
  try {
    process.stderr.write(`[pilot-inject] ${msg}\n`);
  } catch { /* ignore */ }
}

/**
 * Resolve the data dir exactly as loadConfig() does, including the config
 * file's `dataDir`. The chain lives in utils/data-dir.ts — the single home of
 * that precedence — because the hookCommand written into the agent's settings
 * embeds $PILOT_DATA: if this resolves to a different directory than the
 * daemon's loadConfig() will, the two produce different command strings and
 * the daemon appends a duplicate hook.
 */

async function main(): Promise<number> {
  const args = parseInjectArgs(process.argv.slice(2));

  for (const flag of args.unknownFlags) {
    warn(`ignoring unrecognized option ${flag}`);
  }

  // No id list means "detect them all" (see planEagerDeploys). This is the normal
  // case — the list comes from an optional label — so it must not be treated as a
  // missing argument.
  const sweep = args.agents.length === 0;

  const pilotDir = args.pilotDir ? resolveHome(args.pilotDir) : path.resolve(__inject_dirname, '..');
  const dataDir = resolveDataDir(args.dataDir);

  // Constructed to match DeploymentManager argument for argument — see the
  // duplicate-hook hazard in resolveDataDir().
  const loader = new AgentDefLoader({
    builtinDir: path.join(pilotDir, 'agents.d'),
    localDir: path.join(dataDir, 'agents.d.local'),
    pilotDir,
    dataDir,
  });
  const hookManager = new HookManager(path.join(dataDir, 'hooks'), path.join(dataDir, 'logs'));
  const hookStrategy = new HookStrategy(hookManager);
  const pluginInjectStrategy = new PluginInjectStrategy(dataDir, pilotDir);

  const defs = await loader.load();
  const plan = planEagerDeploys(defs, args.agents);
  const byId = new Map(defs.map(def => [def.id, def]));

  // Names of the agents actually written to, not of the agents considered. Under
  // sweep the plan holds every eager-safe definition while typically one is
  // installed, so reporting the plan would name 19 agents alongside "injected 1".
  const injected: string[] = [];
  let failed = 0;

  for (const entry of plan) {
    if (entry.action === 'unknown-id') {
      warn(`no agent definition has id "${entry.agentId}" — skipping it;`
        + ' the daemon will still deploy every agent it detects, so collection is unaffected');
      continue;
    }
    if (entry.action === 'deferred') {
      warn(`${entry.agentId} uses deployMode=${entry.deployMode}, which is not deployed eagerly`
        + ' — leaving it to the daemon');
      continue;
    }

    const def = byId.get(entry.agentId)!;
    const strategy = def.deployMode === 'hook' ? hookStrategy : pluginInjectStrategy;
    try {
      if (!await strategy.detect(def)) {
        // Silent under sweep: "not detected" is the expected answer for ~18 of
        // the 19 candidates, and one line each would be 18 stderr lines in every
        // Pod. When a caller named the agent explicitly it is worth a line —
        // they asserted it should be here and it is not.
        if (!sweep) warn(`${def.id} not detected in this container — skipping`);
        continue;
      }
      // Kept even though both eager strategies' deploy() are idempotent: it
      // makes "already present" a distinct, reportable outcome, and it is the
      // guard that keeps this loop safe if EAGER_DEPLOY_MODES ever widens.
      if (!await strategy.needsDeploy(def)) {
        continue;
      }
      const result = await strategy.deploy(def);
      if (result.success) {
        injected.push(def.id);
      } else {
        failed++;
        warn(`failed to inject ${def.id}: ${result.error ?? 'unknown error'}`);
      }
    } catch (err) {
      failed++;
      warn(`failed to inject ${def.id}: ${(err as Error).message}`);
    }
  }

  if (injected.length > 0) {
    warn(`injected ${injected.length} agent(s) before startup: ${injected.join(', ')}`);
  }

  // Non-zero only when an eligible, detected agent actually failed to deploy.
  // The caller uses this to decide whether to keep its "already done" sentinel,
  // so unknown ids and undetected agents must NOT be reported as failures.
  return failed > 0 ? 1 : 0;
}

// Only run when executed as the entry point. Without this guard, importing the
// module to unit-test parseInjectArgs/planEagerDeploys would run the whole
// injection and call process.exit() out from under the test runner.
const isEntryPoint = typeof require !== 'undefined'
  && typeof module !== 'undefined'
  && require.main === module;

if (isEntryPoint) {
  main()
    .then(code => {
      // Explicit exit rather than falling off the end. This entry never calls
      // initFileLogging() (which is what starts pino-roll, whose rotation timer
      // keeps the event loop alive — see the same hazard called out in
      // src/index.ts), but the caller blocks on us in spawnSync, so anything
      // holding the loop open would stall the agent until its timeout fires.
      // Exit unconditionally rather than trusting that invariant forever.
      process.exit(code);
    })
    .catch(err => {
      // Never let a throw here surface as a crash the caller has to interpret;
      // it must also never be silent, since the whole point is that a missing
      // injection is invisible otherwise.
      warn(`aborted: ${(err as Error)?.message ?? String(err)}`);
      process.exit(1);
    });
}
