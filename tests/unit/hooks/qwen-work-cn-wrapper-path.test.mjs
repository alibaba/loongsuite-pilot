import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const shell = readFileSync(resolve('assets/hooks/qwenworkcn-loongsuite-pilot-hook.sh'), 'utf-8');
const powershell = readFileSync(resolve('assets/hooks/qwenworkcn-loongsuite-pilot-hook.ps1'), 'utf-8');
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

  it('derives token intercept output from the runtime wrapper location', () => {
    expect(runtime).toContain('const WRAPPER_PATH = fileURLToPath(import.meta.url)');
    expect(runtime).toContain("const PILOT_DATA_DIR = path.dirname(path.dirname(WRAPPER_PATH))");
    expect(runtime).toContain("const INTERCEPT_DIR = path.join(PILOT_DATA_DIR, 'logs')");
    expect(runtime).not.toContain('os.homedir()');
  });
});
