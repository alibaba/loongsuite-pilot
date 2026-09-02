import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const SERVICE_PS1 = 'scripts/loongsuite-pilot.ps1';
const text = readFileSync(SERVICE_PS1, 'utf-8');
const codeOf = (source) => source
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

const bodyOf = (name) => {
  const start = text.indexOf(`function ${name} {`);
  expect(start, `${name} not found in ${SERVICE_PS1}`).toBeGreaterThan(-1);
  const rest = text.slice(start + `function ${name} {`.length);
  const end = rest.search(/\nfunction \S+ \{/);
  return codeOf(end === -1 ? rest : rest.slice(0, end));
};

describe('Windows updater handoff and collector recovery commands', () => {
  it('start-collector never stops or scans processes', () => {
    const body = bodyOf('Cmd-StartCollector');
    expect(body).not.toContain('Stop-PidFile');
    expect(body).not.toContain('Stop-OrphanProcesses');
    expect(body).not.toContain('Stop-ScheduledTask');
    expect(body).not.toContain('Start-Job');
    expect(body).toContain('Start-ScheduledTask');
    expect(body).toContain('Install-CollectorTask $nodeBin -SkipCleanup');
  });

  it('missing-task repair skips destructive collector cleanup', () => {
    const body = bodyOf('Install-CollectorTask');
    expect(body).toContain('[switch]$SkipCleanup');
    expect(body).toMatch(/if \(-not \$SkipCleanup\) \{[\s\S]*Stop-OrphanProcesses/);
    expect(body).toMatch(/if \(-not \$SkipCleanup\) \{[\s\S]*schtasks\.exe \/Delete/);
  });

  it('restart-collector can defer updater restart until health validation completes', () => {
    const body = bodyOf('Cmd-RestartCollector');
    expect(body).toContain('--defer-updater-restart');
    expect(body).toMatch(/if \(-not \$deferUpdaterRestart\) \{\s*Schedule-UpdaterRestart/);
    expect(body).not.toContain('Start-Job');
  });

  it('schedules the delayed updater restart in an independent process', () => {
    const body = bodyOf('Schedule-UpdaterRestart');
    expect(body).toContain('Start-Sleep -Seconds 10');
    expect(body).toContain('restart-updater');
    expect(body).toContain('Start-Process -FilePath "powershell.exe"');
    expect(body).not.toContain('Start-Job');
  });

  it('dispatches all three updater lifecycle commands', () => {
    const dispatch = codeOf(text.slice(text.indexOf('switch ($Command.ToLower())')));
    expect(dispatch).toContain('"start-collector"');
    expect(dispatch).toContain('"restart-collector"');
    expect(dispatch).toContain('Cmd-RestartCollector -Options $SubArgs');
    expect(dispatch).toContain('"schedule-updater-restart"');
  });
});
