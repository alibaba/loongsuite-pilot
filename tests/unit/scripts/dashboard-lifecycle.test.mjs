import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const runtimeSh = readFileSync(resolve('scripts', 'loongsuite-pilot.sh'), 'utf8');
const runtimePs1 = readFileSync(resolve('scripts', 'loongsuite-pilot.ps1'), 'utf8');
const externalInstallerSh = readFileSync(resolve('deploy', 'installer.sh'), 'utf8');
const externalInstallerPs1 = readFileSync(resolve('deploy', 'installer.ps1'), 'utf8');
const opensourceInstallerSh = readFileSync(resolve('deploy', 'installer-opensource.sh'), 'utf8');
const opensourceInstallerPs1 = readFileSync(resolve('deploy', 'installer-opensource.ps1'), 'utf8');
const dashboardHtml = readFileSync(resolve('assets', 'dashboard', 'index.html'), 'utf8');

describe('dashboard service lifecycle', () => {
  it('does not expose the removed monitor command', () => {
    const helpAndDispatch = runtimeSh.slice(runtimeSh.indexOf('cmd_help()'));
    expect(helpAndDispatch).not.toMatch(/monitor (start|stop)/);
    expect(helpAndDispatch).not.toMatch(/^\s*monitor\)/m);
  });

  it('cleans legacy standalone processes on start, stop, and collector restart', () => {
    for (const command of ['cmd_start', 'cmd_stop', 'cmd_restart_collector']) {
      const body = runtimeSh.slice(runtimeSh.indexOf(`${command}()`));
      expect(body.split('\n').slice(0, 4).join('\n')).toContain('cleanup_legacy_monitor_processes');
    }
  });

  it('validates a legacy PID command line before killing it', () => {
    const cleanup = runtimeSh.slice(
      runtimeSh.indexOf('cleanup_legacy_monitor_process()'),
      runtimeSh.indexOf('cleanup_legacy_monitor_processes()'),
    );
    expect(cleanup.indexOf('ps -p "$pid" -o command=')).toBeLessThan(cleanup.indexOf('kill "$pid"'));
    expect(cleanup).toContain('[[ "$command_line" == *"$script_name"* ]]');
    expect(cleanup).toContain('rm -f "$pid_file"');
    expect(cleanup).not.toContain('pkill');
  });

  it('repairs a stale collector PID only from the exact installed bootstrap path', () => {
    const processLookup = runtimeSh.slice(
      runtimeSh.indexOf('process_matches_installed_entry()'),
      runtimeSh.indexOf('is_pid_file_running()'),
    );

    expect(processLookup).toContain('[ -r "/proc/$pid/cmdline" ]');
    expect(processLookup).toContain('[ "$argv_entry" = "$expected_entry" ]');
    expect(processLookup).toContain('ps -U "$(id -u)" -o pid= -o ucomm=');
    expect(processLookup).toContain('find_current_user_processes collector');
    expect(processLookup).toContain('node:node|node:nodejs');
    expect(processLookup).toContain('[[ "$command_line" == *" $expected_suffix" ]]');
    expect(processLookup).toContain('process_matches_installed_entry "$pid" collector');
    expect(processLookup).toContain('mv -f "$pid_tmp" "$PID_FILE"');
    expect(processLookup).not.toContain('pgrep');
    expect(processLookup).not.toContain('pkill');
  });

  it('stops exact installed collector wrappers with a short retry', () => {
    const stopHelper = runtimeSh.slice(
      runtimeSh.indexOf('stop_installed_collector_processes()'),
      runtimeSh.indexOf('is_pid_file_running()'),
    );
    const stopCommand = runtimeSh.slice(
      runtimeSh.indexOf('cmd_stop()'),
      runtimeSh.indexOf('cmd_restart_collector()'),
    );
    const restartCommand = runtimeSh.slice(
      runtimeSh.indexOf('cmd_restart_collector()'),
      runtimeSh.indexOf('cmd_restart_updater()'),
    );

    expect(stopHelper).toContain('find_current_user_processes collector-wrapper');
    expect(stopHelper).toContain('find_current_user_processes collector');
    expect(stopHelper).toContain('process_matches_installed_entry "$pid" "$kind"');
    expect(stopHelper).toContain('for attempt in 1 2 3 4 5');
    expect(stopCommand).toContain('stop_installed_collector_processes');
    expect(stopCommand).toContain('stop_pid_file "$PID_FILE" collector');
    expect(stopCommand).toContain('stop_pid_file "$UPDATER_PID_FILE" updater');
    expect(restartCommand).toContain('stop_pid_file "$PID_FILE" collector');
    expect(runtimeSh).not.toContain('pkill -f "loongsuite-pilot/bin/collector-daemon"');
    expect(runtimeSh).not.toContain('pkill -f "loongsuite-pilot/bin/updater-daemon"');
  });

  it('rejects a reused PID and repairs it from the real Node argv entry', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'pilot-lifecycle-'));
    const bootstrapDir = resolve(root, 'bin');
    const entry = resolve(bootstrapDir, 'collector-daemon.js');
    const pidFile = resolve(root, 'loongsuite-pilot.pid');
    mkdirSync(bootstrapDir, { recursive: true });
    writeFileSync(entry, 'setInterval(() => {}, 1000);\n');

    const collector = spawn(process.execPath, [entry], { stdio: 'ignore' });
    const reused = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', entry], {
      stdio: 'ignore',
    });
    const functions = runtimeSh.slice(
      runtimeSh.indexOf('process_matches_installed_entry()'),
      runtimeSh.indexOf('# One-way migration cleanup'),
    );
    const env = {
      ...process.env,
      BOOTSTRAP_DIR: bootstrapDir,
      LOONGSUITE_PILOT_BIN: resolve(root, 'loongsuite-pilot'),
      PID_FILE: pidFile,
    };

    try {
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
      writeFileSync(pidFile, `${reused.pid}\n`);
      const stopped = spawnSync('bash', ['-c', `${functions}\nstop_pid_file "$PID_FILE" collector`], {
        env,
        encoding: 'utf8',
      });
      expect(stopped.status).toBe(0);
      expect(() => process.kill(reused.pid, 0)).not.toThrow();

      writeFileSync(pidFile, `${reused.pid}\n`);
      const repaired = spawnSync('bash', ['-c', `${functions}\nis_running && cat "$PID_FILE"`], {
        env,
        encoding: 'utf8',
      });
      expect(repaired.status).toBe(0);
      expect(repaired.stdout.trim()).toBe(String(collector.pid));
    } finally {
      collector.kill('SIGTERM');
      reused.kill('SIGTERM');
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('generated init.d scripts do not signal a reused PID', async () => {
    const definitions = [
      ['_write_initd_script()', '_write_initd_updater_script()', 'run'],
      ['_write_initd_updater_script()', '_register_initd_boot()', 'run-updater'],
    ];
    const daemonUser = spawnSync('id', ['-un'], { encoding: 'utf8' }).stdout.trim();
    const daemonGroup = spawnSync('id', ['-gn'], { encoding: 'utf8' }).stdout.trim();

    for (const [startMarker, endMarker, command] of definitions) {
      const root = mkdtempSync(resolve(tmpdir(), 'pilot-initd-'));
      const daemonBin = resolve(root, 'loongsuite-pilot');
      const pidFile = resolve(root, 'pilot.pid');
      const section = runtimeSh.slice(runtimeSh.indexOf(startMarker), runtimeSh.indexOf(endMarker));
      const template = section.match(/<< 'INITEOF'\n([\s\S]*?)\nINITEOF/)?.[1];
      expect(template).toBeTruthy();
      const replacements = {
        USER_PLACEHOLDER: daemonUser,
        GROUP_PLACEHOLDER: daemonGroup,
        HOME_PLACEHOLDER: root,
        BIN_PLACEHOLDER: daemonBin,
        DAEMON_NAME_PLACEHOLDER: `pilot-${command}`,
        PID_PLACEHOLDER: pidFile,
        LOG_PLACEHOLDER: resolve(root, 'pilot.log'),
        CONFIG_PLACEHOLDER: resolve(root, 'config.json'),
      };
      let initScript = template;
      for (const [placeholder, value] of Object.entries(replacements)) {
        initScript = initScript.replaceAll(placeholder, value);
      }
      const scriptPath = resolve(root, 'init-script');
      writeFileSync(scriptPath, initScript, { mode: 0o755 });

      const reused = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        env: {
          ...process.env,
          LOONGSUITE_PILOT_INITD_BIN: daemonBin,
          LOONGSUITE_PILOT_INITD_COMMAND: command,
        },
        stdio: 'ignore',
      });
      try {
        await new Promise(resolveWait => setTimeout(resolveWait, 30));
        writeFileSync(pidFile, `${reused.pid}\n`);
        const status = spawnSync('bash', [scriptPath, 'status'], { encoding: 'utf8' });
        expect(status.status).toBe(1);

        const stopped = spawnSync('bash', [scriptPath, 'stop'], { encoding: 'utf8' });
        expect(stopped.status).toBe(0);
        expect(() => process.kill(reused.pid, 0)).not.toThrow();
      } finally {
        reused.kill('SIGTERM');
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('probes the dashboard before printing its URL on Unix and Windows', () => {
    const unixProbe = runtimeSh.slice(
      runtimeSh.indexOf('dashboard_is_available()'),
      runtimeSh.indexOf('cmd_status()'),
    );
    const windowsProbe = runtimePs1.slice(
      runtimePs1.indexOf('function Test-DashboardAvailable'),
      runtimePs1.indexOf('function Cmd-Status'),
    );

    for (const probe of [unixProbe, windowsProbe]) {
      expect(probe).toContain('require("node:http")');
      expect(probe).toContain('path: "/metrics-summary.json"');
      expect(probe).toContain('method: "HEAD"');
      expect(probe).toContain('setTimeout');
      expect(probe).toContain('}, 300)');
    }
    expect(runtimeSh).toContain('port = JSON.parse(fs.readFileSync(path, "utf8"))?.dashboard?.port');
    expect(runtimeSh).toContain('? port : 8765');
    expect(runtimeSh).toContain('http://127.0.0.1:${port}/');
    expect(runtimePs1).toContain('function Get-DashboardPort');
    expect(runtimePs1).toContain('return 8765');
    expect(runtimePs1).toContain('http://127.0.0.1:$dashboardPort/');
    expect(runtimeSh).not.toContain('18765');
    expect(runtimePs1).not.toContain('18765');
  });

  it('external installers add the default port without overwriting an explicit port', () => {
    for (const installer of [
      externalInstallerSh,
      externalInstallerPs1,
      opensourceInstallerSh,
      opensourceInstallerPs1,
    ]) {
      expect(installer).toContain("if (config.dashboard.port === undefined) config.dashboard.port = 8765;");
      expect(installer).not.toContain('config.dashboard.port = 8765;\nif (config.dashboard.port');
    }
  });
});

describe('dashboard static page', () => {
  it('reads only metrics-summary.json and renders agentShares dynamically', () => {
    expect(dashboardHtml).toContain("fetch('/metrics-summary.json'");
    expect(dashboardHtml).toContain('today.agentShares');
    expect(dashboardHtml).toContain('agentShares.map');
    expect(dashboardHtml).not.toContain('/api/overview');
    expect(dashboardHtml).not.toContain('/api/metrics');
  });

  it('labels agent shares as event counts and renders a full-width empty state', () => {
    expect(dashboardHtml).not.toContain('本页直接展示');
    expect(dashboardHtml).not.toContain('Token 占比');
    expect(dashboardHtml).toContain('事件数占比');
    expect(dashboardHtml).toContain('占今日全部 Agent 事件');
    expect(dashboardHtml).toContain('暂时没有检测到 Agent Token 数据');
    expect(dashboardHtml).toContain('.agent-empty { grid-column: 1 / -1;');
    expect(dashboardHtml).toContain('<div class="label">Event</div>');
  });

  it('uses custom mouse and keyboard tooltips for trend values', () => {
    expect(dashboardHtml).toContain('class="trend-tooltip" role="tooltip"');
    expect(dashboardHtml).toContain('aria-label="${escapeHtml(ariaLabel)}"');
    expect(dashboardHtml).toContain("bar.addEventListener('mouseenter', showTrendTooltip)");
    expect(dashboardHtml).toContain("bar.addEventListener('focus', showTrendTooltip)");
    expect(dashboardHtml).toContain("bar.addEventListener('blur', hideTrendTooltip)");
    expect(dashboardHtml).toContain("tooltip.setAttribute('aria-hidden', 'false')");
    expect(dashboardHtml).toContain("tooltip?.setAttribute('aria-hidden', 'true')");
    expect(dashboardHtml).not.toContain('class="trend-bar" title=');
  });

  it('preserves focused trend days across refreshes', () => {
    expect(dashboardHtml).toContain('const focusedDay = container.contains(activeElement)');
    expect(dashboardHtml).toContain('bar.dataset.day === focusedDay');
    expect(dashboardHtml).toContain('.focus({ preventScroll: true })');
  });

  it('uses a full-column hit target and clamps custom tooltips', () => {
    expect(dashboardHtml).toContain('.trend-bar {\n      display: flex; align-items: flex-end;');
    expect(dashboardHtml).toContain('height: 100%');
    expect(dashboardHtml).toContain('<span class="trend-bar-fill" style="height:${height}px"></span>');
    expect(dashboardHtml).toContain("bar.querySelector('.trend-bar-fill').getBoundingClientRect()");
    expect(dashboardHtml).toContain('window.innerWidth - tooltipRect.width - 4');
    expect(dashboardHtml).toContain('wrapRect.right - tooltipRect.width - 4');
    expect(dashboardHtml).toContain('clamp(desiredTop, 4, maxTop)');

    const clampMatch = dashboardHtml.match(/const clamp = \(value, min, max\) => ([^;]+);/);
    expect(clampMatch).not.toBeNull();
    const clamp = Function('value', 'min', 'max', `return ${clampMatch[1]};`);
    expect(clamp(-5, 4, 100)).toBe(4);
    expect(clamp(150, 4, 100)).toBe(100);
    expect(clamp(20, 4, 100)).toBe(20);
    expect(clamp(20, 40, 10)).toBe(40);
  });

  it('formats only token values compactly at explicit boundaries', () => {
    const countMatch = dashboardHtml.match(/const count = ([^;]+);/);
    const tokenCountMatch = dashboardHtml.match(/function tokenCount\(value\) \{([\s\S]*?)\n    \}/);
    expect(countMatch).not.toBeNull();
    expect(tokenCountMatch).not.toBeNull();
    const tokenCount = Function(`
      const count = ${countMatch[1]};
      return function tokenCount(value) {${tokenCountMatch[1]}\n      };
    `)();

    expect(tokenCount(999_999)).toBe('999,999');
    expect(tokenCount(1_000_000)).toBe('1M');
    expect(tokenCount(1_500_000)).toBe('1.5M');
    expect(tokenCount(141_688_729)).toBe('141.69M');
    expect(tokenCount(1_000_000_000)).toBe('1B');
    expect(tokenCount(1_250_000_000)).toBe('1.25B');
    expect(tokenCount(1_000_000_000_000)).toBe('1000B');
    expect(tokenCount(-141_688_729)).toBe('-141.69M');
    expect(tokenCount(Number.NaN)).toBe('0');
  });

  it('applies compact formatting to every token semantic but not other counts', () => {
    expect(dashboardHtml).toContain('${tokenCount(agent.tokens)}');
    expect(dashboardHtml).toContain("$('tokens').textContent = tokenCount(today.totalTokens)");
    expect(dashboardHtml).toContain('输入 ${tokenCount(today.inputTokens)}');
    expect(dashboardHtml).toContain('输出 ${tokenCount(today.outputTokens)}');
    expect(dashboardHtml).toContain('缓存读取 ${tokenCount(today.cacheReadTokens)}');
    expect(dashboardHtml).toContain("'Token', tokenCount");
    expect(dashboardHtml).toContain("'Session', count");
    expect(dashboardHtml).toContain("'model', 'totalTokens', tokenCount");
    expect(dashboardHtml).toContain("'provider', 'totalTokens', tokenCount");
    expect(dashboardHtml).toContain("$('sessions').textContent = count(today.totalSessions)");
    expect(dashboardHtml).toContain('${count(agent.sessions)}');
    expect(dashboardHtml).toContain('${count(agent.events)}');
  });
});
