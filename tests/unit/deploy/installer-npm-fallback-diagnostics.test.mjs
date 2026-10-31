/**
 * The npm fallback must not answer "why did the install fail?" with the path to
 * the log that holds the answer.
 *
 * Symptom this pins (issue #465): `run_npm install ... 2>&1 | tail -1` kept only
 * npm's final line, which is `npm ERR! /home/<user>/.npm/_logs/<ts>-debug-0.log`.
 * The actionable cause (`gyp ERR! stack Error: not found: make`) lived inside
 * that file, and the caller then reported the whole failure as
 * "hook script deployment failed" even though no hook step had run.
 *
 * Rule: keep the full npm output under the data dir, print the log path plus the
 * actionable lines, classify the common causes, and let the caller name the
 * stage that actually failed.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sh = readFileSync(resolve('deploy', 'installer-opensource.sh'), 'utf8');
const ps1 = readFileSync(resolve('deploy', 'installer-opensource.ps1'), 'utf8');

const SECTION = '\n# ============================================================';

/** Body of `name() { ... }` up to the next top-level section header. */
function shFn(name) {
  const start = sh.indexOf(`${name}() {`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const end = sh.indexOf(SECTION, start + 1);
  return end > start ? sh.slice(start, end) : sh.slice(start);
}

describe('installer npm fallback keeps the real error (issue #465)', () => {
  it('captures the whole npm output instead of the last line', () => {
    const body = shFn('deploy_package');

    expect(body).not.toMatch(/--no-optional 2>&1 \| tail -1/);
    expect(body).toContain('npm_log="$(npm_fallback_log_path)"');
    expect(body).toContain('run_npm install --production --no-optional) >"$npm_log" 2>&1');
    expect(body).toContain('report_npm_fallback_diagnostics "$npm_log"');
  });

  it('writes the npm log under the data directory', () => {
    const logPath = shFn('npm_fallback_log_path');

    expect(logPath).toContain('local log_dir="$DATA_DIR/logs"');
    expect(logPath).toContain('install-npm-%s.log');
    // An unwritable data dir must not cost the install its only diagnosis.
    expect(logPath).toContain('${TMPDIR:-/tmp}');
  });

  it('prints the log path plus an ERR-filtered excerpt', () => {
    const report = shFn('report_npm_fallback_diagnostics');

    expect(report).toContain('Full npm output');
    expect(report).toContain('npm (ERR|WARN)!|npm (error|warn)|gyp (ERR|WARN)!|ERR!');
    expect(report).toContain('tail -n 30');
    // No ERR-matching line means the filter found nothing usable; the raw tail is
    // then better than silence.
    expect(report).toContain('Last 30 lines of output');
    expect(report).toContain('print_npm_fallback_hint');
  });

  it('classifies the common failures from the issue', () => {
    const hint = shFn('print_npm_fallback_hint');

    expect(hint).toContain('not found: (make|g\\+\\+|gcc|c\\+\\+|cc1plus)');
    expect(hint).toContain('No module named');
    expect(hint).toContain('distutils');
    expect(hint).toContain('Python\\.h');
    expect(hint).toContain('ETIMEDOUT');
    expect(hint).toContain('registry\\.npmjs\\.org');
    expect(hint).toContain('EACCES');
    expect(hint).toContain('ENOSPC');
  });

  it('names the failing stage instead of blaming hooks', () => {
    const body = shFn('deploy_package');
    const npmFailAt = body.indexOf('Dependency installation failed');

    expect(npmFailAt).toBeGreaterThan(-1);
    expect(body.slice(0, npmFailAt)).toContain('DEPLOY_FAILED_STAGE="dependencies"');
    // Both postinstall outcomes (exit code and partial asset trees) are hook failures.
    expect(body.match(/DEPLOY_FAILED_STAGE="hooks"/g)?.length).toBe(2);
    expect(body).toContain('DEPLOY_FAILED_STAGE="files"');

    const label = shFn('deploy_failure_label');
    expect(label).toContain('dependencies)');
    expect(label).toContain('hooks)');
    expect(label).toContain('files)');
  });

  it('reports the real stage from install and upgrade', () => {
    const install = shFn('cmd_install');
    expect(install).toContain('deploy_failure_label');
    expect(install).toContain('${deploy_reason_zh}');
    expect(install).toContain('${deploy_reason_en}');
    expect(install.toLowerCase()).not.toContain('aborted: hook script deployment failed');

    const upgrade = shFn('cmd_upgrade');
    expect(upgrade).toContain('deploy_failure_label');
    expect(upgrade).toContain('${deploy_reason_en}');
    expect(upgrade).not.toContain('deploy/dependency error');
  });

  it('keeps npm output on disk in the Windows installer too', () => {
    const start = ps1.indexOf('function Deploy-Package {');
    expect(start).toBeGreaterThan(-1);
    const end = ps1.indexOf(SECTION, start + 1);
    const body = ps1.slice(start, end);

    expect(body).not.toMatch(/Select-Object -Last 1/);
    expect(body).toContain('install-npm-');
    expect(body).toContain('Full npm output');
    expect(body).toContain('Print-NpmFallbackHint');

    const hintStart = ps1.indexOf('function Print-NpmFallbackHint {');
    expect(hintStart).toBeGreaterThan(-1);
    const hintEnd = ps1.indexOf(SECTION, hintStart + 1);
    const hint = ps1.slice(hintStart, hintEnd);
    expect(hint).toContain('Build Tools');
    expect(hint).toContain('distutils');
    expect(hint).toContain('EAI_AGAIN');
  });
});
