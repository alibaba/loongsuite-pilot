import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const shell = readFileSync(resolve('assets/hooks/qwenworkcn-loongsuite-pilot-hook.sh'), 'utf-8');
const powershell = readFileSync(resolve('assets/hooks/qwenworkcn-loongsuite-pilot-hook.ps1'), 'utf-8');
const qoderShell = readFileSync(resolve('assets/hooks/qoderwork-loongsuite-pilot-hook.sh'), 'utf-8');
const qoderPowershell = readFileSync(resolve('assets/hooks/qoderwork-loongsuite-pilot-hook.ps1'), 'utf-8');
const commonPowershell = readFileSync(resolve('assets/hooks/shared/common.ps1'), 'utf-8');
const shellRuntime = readFileSync(resolve('assets/hooks/shared/node-runtime.sh'), 'utf-8');
const runtime = readFileSync(resolve('assets/hooks/qoderwork-runtime-wrapper.mjs'), 'utf-8');

describe('QwenWorkCN wrapper dataDir propagation', () => {
  it('derives the shell Hook dataDir from its deployed hooks directory', () => {
    expect(shell).toContain('PILOT_DATA_DIR="$(cd "$HOOKS_DIR/.." && pwd)"');
    expect(shell).toContain('export LOONGSUITE_PILOT_DATA_DIR="$PILOT_DATA_DIR"');
  });

  it('derives the PowerShell Hook dataDir from its deployed hooks directory', () => {
    expect(powershell).toContain('$PilotDataDir = Split-Path -Parent $ScriptDir');
    expect(powershell).toContain('$env:LOONGSUITE_PILOT_DATA_DIR = $PilotDataDir');
  });

  it('keeps QwenWorkCN shell runtime lookup aligned with QoderWork managed-node support', () => {
    expect(shell).toContain('shared/node-runtime.sh');
    expect(shell).toContain('resolve_pilot_node_bin');
    expect(shellRuntime).toContain('runtime_dir="$(dirname "$pin_file")/runtime"');
    expect(qoderShell).toContain('runtime_dir="$(dirname "$NODE_PIN_FILE")/runtime"');
    for (const source of [shellRuntime, qoderShell]) {
      expect(source).toContain('sort_version_dirs_desc()');
      expect(source).toContain('.nvm/versions/node');
      expect(source).toContain('.fnm/aliases/default/bin/node');
      expect(source).toContain('.volta/bin/node');
    }
    expect(qoderShell).toContain('export LOONGSUITE_PILOT_DATA_DIR="$PILOT_DATA_DIR"');
  });

  it('uses the same PowerShell runtime resolver for QwenWorkCN and QoderWork', () => {
    for (const wrapper of [powershell, qoderPowershell]) {
      expect(wrapper).toContain('shared\\common.ps1');
      expect(wrapper).toContain('Resolve-NodeBin');
    }
    expect(powershell).not.toContain('(Get-Command node -ErrorAction SilentlyContinue).Source');
    expect(commonPowershell).toContain('$env:LOONGSUITE_PILOT_DATA_DIR');
    expect(commonPowershell).toContain('$env:LOONGSUITE_PILOT_CACHE_DIR');
    expect(commonPowershell).toContain('$script:MIN_NODE_MAJOR = 18');
  });

  it('derives token intercept output from the runtime wrapper location', () => {
    expect(runtime).toContain('const WRAPPER_PATH = fileURLToPath(import.meta.url)');
    expect(runtime).toContain("const PILOT_DATA_DIR = path.dirname(path.dirname(WRAPPER_PATH))");
    expect(runtime).toContain("const INTERCEPT_DIR = path.join(PILOT_DATA_DIR, 'logs')");
    expect(runtime).not.toContain('os.homedir()');
  });
});
