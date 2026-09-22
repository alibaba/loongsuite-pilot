import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { resolveHome } from '../utils/fs-utils.js';

const BEGIN = '# >>> loongsuite-pilot copilot otel >>>';
const END = '# <<< loongsuite-pilot copilot otel <<<';
const blockPattern = /\n?# >>> loongsuite-pilot copilot otel >>>[\s\S]*?# <<< loongsuite-pilot copilot otel <<<\n?/g;
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function copilotShellBlock(dataDir: string, powershell = false): string {
  const dir = path.join(dataDir, 'state', 'copilot', 'otel');
  const marker = path.join(dataDir, 'state', 'copilot', 'otel-enabled');
  if (powershell) return `${BEGIN}
if ((Test-Path -LiteralPath ${psQuote(marker)}) -and -not $env:COPILOT_OTEL_FILE_EXPORTER_PATH -and -not $env:OTEL_EXPORTER_OTLP_ENDPOINT -and -not $env:COPILOT_OTEL_EXPORTER_TYPE -and -not $env:COPILOT_OTEL_ENABLED) {
  try {
    $pilotCopilotOtelDir = ${psQuote(dir)}
    [void][System.IO.Directory]::CreateDirectory($pilotCopilotOtelDir)
    $env:COPILOT_OTEL_FILE_EXPORTER_PATH = Join-Path $pilotCopilotOtelDir ("copilot-" + [guid]::NewGuid().ToString() + ".jsonl")
  } catch { }
}
${END}
`;
  return `${BEGIN}
if [ -f ${quote(marker)} ] && [ -z "\${COPILOT_OTEL_FILE_EXPORTER_PATH+x}" ] && [ -z "\${OTEL_EXPORTER_OTLP_ENDPOINT+x}" ] && [ -z "\${COPILOT_OTEL_EXPORTER_TYPE+x}" ] && [ -z "\${COPILOT_OTEL_ENABLED+x}" ]; then
  if (umask 077; mkdir -p ${quote(dir)}); then
    export COPILOT_OTEL_FILE_EXPORTER_PATH=${quote(dir)}/copilot-$(date -u +%Y%m%dT%H%M%S)-$$.jsonl
  fi
fi
${END}
`;
}

function profiles(homeDir = resolveHome('~')): string[] {
  return process.platform === 'win32'
    ? ['~/Documents/PowerShell/Microsoft.PowerShell_profile.ps1', '~/Documents/WindowsPowerShell/Microsoft.PowerShell_profile.ps1'].map(p => path.join(homeDir, p.slice(2)))
    : ['~/.bashrc', '~/.zshrc'].map(p => path.join(homeDir, p.slice(2)));
}
export async function installCopilotShellIntegration(dataDir: string, homeDir?: string): Promise<void> {
  const dir = path.join(dataDir, 'state', 'copilot');
  await fs.mkdir(path.join(dir, 'otel'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(dir, 'otel-enabled'), '', { mode: 0o600 });
  for (const profile of profiles(homeDir)) {
    let existing = '';
    try { existing = await fs.readFile(profile, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const next = existing.replace(blockPattern, '\n').replace(/\n*$/, '\n') + copilotShellBlock(dataDir, process.platform === 'win32');
    await fs.mkdir(path.dirname(profile), { recursive: true });
    await fs.writeFile(profile, next, { mode: 0o600 });
  }
}
export async function needsCopilotShellIntegration(dataDir: string, homeDir?: string): Promise<boolean> {
  try {
    await fs.access(path.join(dataDir, 'state', 'copilot', 'otel-enabled'));
    for (const profile of profiles(homeDir)) if (!(await fs.readFile(profile, 'utf8')).includes(copilotShellBlock(dataDir, process.platform === 'win32'))) return true;
    return false;
  } catch { return true; }
}
export async function removeCopilotShellIntegration(dataDir: string, homeDir?: string): Promise<void> {
  await fs.rm(path.join(dataDir, 'state', 'copilot', 'otel-enabled'), { force: true });
  for (const profile of profiles(homeDir)) {
    try {
      const before = await fs.readFile(profile, 'utf8');
      const after = before.replace(blockPattern, '\n');
      if (before !== after) await fs.writeFile(profile, after);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
}
