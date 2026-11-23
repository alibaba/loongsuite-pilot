import { describe, expect, it } from 'vitest';
import type { DeployResult } from '../../../src/types/index.js';
import {
  collectUnmet,
  deployExitCode,
  parseArgs,
} from '../../../src/deployment/deploy-command.js';

/**
 * `loongsuite-pilot deploy` is the gate an image build hangs on: the whole point
 * of the command is that a non-zero exit stops a broken layer from shipping. So
 * the contract pinned here is the exit code, not the formatting.
 */

const KNOWN = new Set(['hermes-agent', 'claude-code', 'qoder-jetbrains']);

function result(over: Partial<DeployResult> & { agentId: string }): DeployResult {
  return {
    success: true,
    deployMode: 'hook',
    ...over,
  } as DeployResult;
}

const deployed = result({ agentId: 'hermes-agent' });
const upToDate = result({ agentId: 'hermes-agent', skipped: true, reason: 'up-to-date' });
const notDetected = result({ agentId: 'hermes-agent', skipped: true, reason: 'not-detected' });
const disabled = result({ agentId: 'hermes-agent', skipped: true, reason: 'disabled' });
const failed = result({ agentId: 'hermes-agent', success: false, error: 'plugin extract failed' });

function exitCodeFor(results: DeployResult[], required: string[] = []): number {
  return deployExitCode(results, collectUnmet(required, KNOWN, results), false);
}

describe('deploy --require exit codes', () => {
  it('accepts a freshly deployed agent', () => {
    expect(exitCodeFor([deployed], ['hermes-agent'])).toBe(0);
  });

  it('accepts an agent that was already deployed', () => {
    // Idempotence is load-bearing: an image build that keeps deployed-agents.json
    // hits this branch whenever a derived image rebuilds on top of an instrumented
    // base. Treating "already in place" as unmet would make every rebuild fail.
    expect(exitCodeFor([upToDate], ['hermes-agent'])).toBe(0);
  });

  it('rejects an agent that was never detected', () => {
    expect(exitCodeFor([notDetected], ['hermes-agent'])).toBe(1);
  });

  it('rejects an agent turned off by the config.agents gate', () => {
    expect(exitCodeFor([disabled], ['hermes-agent'])).toBe(1);
  });

  it('rejects an agent missing from the result list entirely', () => {
    expect(exitCodeFor([], ['hermes-agent'])).toBe(1);
  });

  it('rejects an id no agent definition claims, instead of silently passing', () => {
    expect(exitCodeFor([deployed], ['hermez-agent'])).toBe(1);
    expect(collectUnmet(['hermez-agent'], KNOWN, [deployed])).toEqual([
      { agentId: 'hermez-agent', reason: 'unknown-id' },
    ]);
  });

  it('reports the underlying error for a hard failure', () => {
    expect(collectUnmet(['hermes-agent'], KNOWN, [failed])).toEqual([
      { agentId: 'hermes-agent', reason: 'failed', error: 'plugin extract failed' },
    ]);
  });

  it('fails on a hard failure even when nothing was required', () => {
    // A caller that passes no --require still needs failures to surface, or an
    // extraction error would pass as a successful build layer.
    expect(exitCodeFor([failed])).toBe(1);
  });

  it('does not fail on a skip when nothing was required', () => {
    expect(exitCodeFor([notDetected, disabled])).toBe(0);
  });

  it('fails when probe workers could not be stopped', () => {
    // A worker.pid baked into the image can collide with an unrelated pid in the
    // container's fresh PID namespace, leaving telemetry silently off.
    expect(deployExitCode([deployed], [], true)).toBe(1);
  });
});

describe('deploy argument parsing', () => {
  it('splits and de-duplicates a comma-separated list', () => {
    expect(parseArgs(['--require', 'a, b ,a']).required).toEqual(['a', 'b']);
    expect(parseArgs(['--require=a,b']).required).toEqual(['a', 'b']);
  });

  it('accepts no --require at all', () => {
    expect(parseArgs([]).required).toEqual([]);
    expect(parseArgs(['--json'])).toEqual({ required: [], json: true });
  });

  it('refuses an empty --require value rather than requiring nothing', () => {
    // `--require "$AGENTS"` with an unset AGENTS used to exit 0 having asserted
    // nothing — the failure mode the flag exists to prevent.
    expect(() => parseArgs(['--require', ''])).toThrow(/empty value/);
    expect(() => parseArgs(['--require', ' , '])).toThrow(/empty value/);
    expect(() => parseArgs(['--require='])).toThrow(/empty value/);
  });

  it('refuses a missing --require value instead of eating the next flag', () => {
    expect(() => parseArgs(['--require'])).toThrow(/requires a value/);
    expect(() => parseArgs(['--require', '--json'])).toThrow(/requires a value/);
  });

  it('refuses unknown options', () => {
    expect(() => parseArgs(['--force'])).toThrow(/unknown option/);
  });
});
