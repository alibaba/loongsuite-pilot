import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const runtimeSh = readFileSync(resolve('scripts', 'loongsuite-pilot.sh'), 'utf8');
const runtimePs1 = readFileSync(resolve('scripts', 'loongsuite-pilot.ps1'), 'utf8');
const opensourceInstallerSh = readFileSync(resolve('deploy', 'installer-opensource.sh'), 'utf8');
const opensourceInstallerPs1 = readFileSync(resolve('deploy', 'installer-opensource.ps1'), 'utf8');
const dashboardHtml = readFileSync(resolve('assets', 'dashboard', 'index.html'), 'utf8');
const dashboardScript = dashboardHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';

function dashboardFunctionSource(name) {
  const match = dashboardScript.match(new RegExp(`function ${name}\\(([^)]*)\\) \\{([\\s\\S]*?)\\n    \\}`));
  expect(match, `${name} should be present in the dashboard script`).not.toBeNull();
  return `function ${name}(${match[1]}) {${match[2]}\n    }`;
}

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
    expect(cleanup).toContain('legacy_monitor_process_matches "$pid" "$script_name"');
    expect(cleanup).toContain('[ "${argv_entry##*/}" = "$script_name" ]');
    expect(cleanup).toContain('[ "$argv_count" -eq 2 ]');
    expect(cleanup).toContain('ps -p "$pid" -o uid=');
    expect(cleanup).toContain('rm -f "$pid_file"');
    expect(cleanup).not.toContain('pkill');
  });

  it('does not kill a reused legacy PID that only mentions the removed script', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'pilot-legacy-monitor-'));
    const pidFile = resolve(root, 'legacy.pid');
    const reused = spawn(process.execPath, [
      '-e',
      'setInterval(() => {}, 1000)',
      'serve-loongsuite-pilot-monitor.mjs',
    ], { stdio: 'ignore' });
    const functions = runtimeSh.slice(
      runtimeSh.indexOf('cleanup_legacy_monitor_process()'),
      runtimeSh.indexOf('updater_process_exists()'),
    );

    try {
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
      writeFileSync(pidFile, `${reused.pid}\n`);
      const cleaned = spawnSync('bash', ['-c', `${functions}\ncleanup_legacy_monitor_process "$1" serve-loongsuite-pilot-monitor.mjs`, 'test', pidFile], {
        encoding: 'utf8',
      });
      expect(cleaned.status).toBe(0);
      expect(() => process.kill(reused.pid, 0)).not.toThrow();
    } finally {
      reused.kill('SIGTERM');
      rmSync(root, { recursive: true, force: true });
    }
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
      expect(probe).toContain('x-loongsuite-pilot-dashboard');
      expect(probe).toContain('x-loongsuite-pilot-instance');
      expect(probe).toContain('metrics-summary-v1');
      expect(probe).toContain('setTimeout');
      expect(probe).toContain('}, 300)');
    }
    expect(runtimeSh).toContain('port = JSON.parse(fs.readFileSync(path, "utf8"))?.dashboard?.port');
    expect(runtimeSh).toContain('configured = JSON.parse(fs.readFileSync(configPath, "utf8"))?.dataDir');
    expect(runtimeSh).toContain('process.env.LOONGSUITE_PILOT_DATA_DIR || configured');
    expect(runtimeSh).toContain('effective_data_dir=$(dashboard_data_dir)');
    expect(runtimeSh).toContain('? port : 8765');
    expect(runtimeSh).toContain('http://127.0.0.1:${port}/');
    expect(runtimePs1).toContain('function Get-DashboardPort');
    expect(runtimePs1).toContain('$numericPort -eq $integerPort');
    expect(runtimePs1).toContain('return 8765');
    expect(runtimePs1).toContain('http://127.0.0.1:$dashboardPort/');
    expect(runtimeSh).not.toContain('18765');
    expect(runtimePs1).not.toContain('18765');
  });

  it('public installers add the default port without overwriting an explicit port', () => {
    for (const installer of [
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
    expect(dashboardHtml).toContain("translate('eventLabel')");
    expect(dashboardHtml).toContain('{percentage}% of all Agent events today');
    expect(dashboardHtml).toContain('No Agent token data detected yet');
  });

  it('keeps complete matching Chinese and English message dictionaries', () => {
    const match = dashboardScript.match(/const messages = (\{[\s\S]*?\n    \});/);
    expect(match).not.toBeNull();
    const dictionary = Function(`return (${match[1]});`)();
    const chineseKeys = Object.keys(dictionary['zh-CN']).sort();
    const englishKeys = Object.keys(dictionary.en).sort();
    expect(englishKeys).toEqual(chineseKeys);

    const staticKeys = [...dashboardHtml.matchAll(/data-i18n(?:-aria-label)?="([^"]+)"/g)]
      .map(([, key]) => key);
    const dynamicKeys = [...dashboardScript.matchAll(/translate\('([^']+)'/g)]
      .map(([, key]) => key);
    for (const key of new Set([...staticKeys, ...dynamicKeys])) {
      expect(dictionary['zh-CN'][key], `missing zh-CN translation for ${key}`).toBeTruthy();
      expect(dictionary.en[key], `missing English translation for ${key}`).toBeTruthy();
    }
  });

  it('detects zh browser preferences and otherwise defaults to English', () => {
    const normalizeLanguage = Function(`return (${dashboardFunctionSource('normalizeLanguage')});`)();
    const detectBrowserLanguage = Function(
      'normalizeLanguage',
      `return (${dashboardFunctionSource('detectBrowserLanguage')});`,
    )(normalizeLanguage);

    expect(normalizeLanguage('zh')).toBe('zh-CN');
    expect(normalizeLanguage('zh-Hant-TW')).toBe('zh-CN');
    expect(normalizeLanguage('en-US')).toBe('en');
    expect(detectBrowserLanguage(['en-US', 'zh-CN'], 'en-US')).toBe('zh-CN');
    expect(detectBrowserLanguage(['fr-FR'], 'fr-FR')).toBe('en');
    expect(detectBrowserLanguage([], 'zh-SG')).toBe('zh-CN');
    expect(detectBrowserLanguage(['en-US'], 'zh-CN')).toBe('zh-CN');
  });

  it('persists language safely and tolerates unavailable localStorage', () => {
    const storageKey = 'loongsuite-pilot.dashboard.language';
    const isSupportedLanguage = Function(`return (${dashboardFunctionSource('isSupportedLanguage')});`)();
    const getLocalStorage = Function(
      'window',
      `return (${dashboardFunctionSource('getLocalStorage')});`,
    )({ get localStorage() { throw new Error('blocked'); } });
    const readStoredLanguage = Function(
      'LANGUAGE_STORAGE_KEY',
      'isSupportedLanguage',
      `return (${dashboardFunctionSource('readStoredLanguage')});`,
    )(storageKey, isSupportedLanguage);
    const writeStoredLanguage = Function(
      'LANGUAGE_STORAGE_KEY',
      `return (${dashboardFunctionSource('writeStoredLanguage')});`,
    )(storageKey);

    expect(getLocalStorage()).toBeNull();
    expect(readStoredLanguage({ getItem: () => 'zh-CN' })).toBe('zh-CN');
    expect(readStoredLanguage({ getItem: () => 'de-DE' })).toBeNull();
    expect(readStoredLanguage({ getItem: () => { throw new Error('blocked'); } })).toBeNull();
    expect(() => writeStoredLanguage({ setItem: () => { throw new Error('blocked'); } }, 'en')).not.toThrow();
    const writes = [];
    writeStoredLanguage({ setItem: (...args) => writes.push(args) }, 'en');
    expect(writes).toEqual([[storageKey, 'en']]);
  });

  it('updates lang and immediately redraws the cached summary on language changes', () => {
    const applyLanguage = dashboardFunctionSource('applyLanguage');
    expect(applyLanguage).toContain('document.documentElement.lang = currentLanguage');
    expect(applyLanguage).toContain("document.querySelectorAll('[data-i18n]')");
    expect(applyLanguage).toContain("document.querySelectorAll('[data-i18n-aria-label]')");
    expect(applyLanguage).toContain('writeStoredLanguage(storage, currentLanguage)');
    expect(applyLanguage).toContain('if (currentSummary) renderSummary(currentSummary)');
    expect(applyLanguage).toContain('renderViewState()');
    expect(applyLanguage).not.toContain('refresh()');
    expect(dashboardHtml).toContain("applyLanguage(event.target.value, true)");
    expect(dashboardHtml).toContain('new Intl.NumberFormat(currentLanguage)');
    expect(dashboardHtml).toContain('date.toLocaleTimeString(currentLanguage)');
    expect(dashboardHtml).toContain('new Intl.DateTimeFormat(currentLanguage');
  });

  it('redraws loaded content immediately without fetching again when language changes', async () => {
    class FakeElement {
      constructor(dataset = {}) {
        this.dataset = dataset;
        this.classList = { toggle: vi.fn() };
        this.listeners = {};
        this.attributes = {};
        this.innerHTML = '';
        this.textContent = '';
        this.value = '';
      }
      addEventListener(name, handler) { this.listeners[name] = handler; }
      setAttribute(name, value) { this.attributes[name] = value; }
      contains() { return false; }
      querySelectorAll() { return []; }
    }

    const ids = [
      'status-dot', 'status-text', 'notice', 'refresh-select', 'language-select',
      'tokens', 'token-detail', 'sessions', 'requests', 'tools', 'agent-grid',
      'token-trend', 'session-trend', 'models', 'providers', 'repos',
    ];
    const elements = Object.fromEntries(ids.map(id => [id, new FakeElement()]));
    const heading = new FakeElement({ i18n: 'agentDistribution' });
    elements['language-select'].dataset.i18nAriaLabel = 'languageAriaLabel';
    const document = {
      activeElement: null,
      documentElement: { lang: '' },
      title: '',
      getElementById: id => elements[id],
      querySelectorAll: selector => selector === '[data-i18n]'
        ? [heading]
        : selector === '[data-i18n-aria-label]'
          ? [elements['language-select']]
          : [],
    };
    const writes = [];
    const window = {
      localStorage: {
        getItem: () => null,
        setItem: (...args) => writes.push(args),
      },
    };
    let resolveFetch;
    const fetch = vi.fn(() => new Promise(resolveFetchPromise => { resolveFetch = resolveFetchPromise; }));
    const setInterval = vi.fn(() => 1);
    const clearInterval = vi.fn();

    Function(
      'window', 'document', 'navigator', 'fetch', 'setInterval', 'clearInterval', 'Intl',
      dashboardScript,
    )(
      window,
      document,
      { languages: ['en-US'], language: 'en-US' },
      fetch,
      setInterval,
      clearInterval,
      Intl,
    );

    expect(document.documentElement.lang).toBe('en');
    expect(heading.textContent).toBe('Agent Distribution');
    resolveFetch({
      status: 200,
      ok: true,
      json: async () => ({
        generatedAt: '2026-08-13T06:00:00.000Z',
        ranges: {
          today: {
            totalTokens: 1500000,
            inputTokens: 1000000,
            outputTokens: 500000,
            cacheReadTokens: 0,
            totalSessions: 2,
            totalRequests: 3,
            totalToolCalls: 4,
            agentShares: [],
            modelShares: [],
            providerShares: [],
            repoShares: [],
          },
        },
        dailyTokens: [],
        dailySessions: [],
      }),
    });
    await new Promise(resolveWait => setImmediate(resolveWait));

    expect(elements['agent-grid'].innerHTML).toContain('No Agent token data detected yet');
    expect(elements['token-detail'].textContent).toContain('Input 1M');
    expect(elements['status-text'].textContent).toContain('Generated at');
    expect(fetch).toHaveBeenCalledTimes(1);

    elements['language-select'].listeners.change({ target: { value: 'zh-CN' } });

    expect(document.documentElement.lang).toBe('zh-CN');
    expect(heading.textContent).toBe('Agent 分布');
    expect(elements['agent-grid'].innerHTML).toContain('暂时没有检测到 Agent Token 数据');
    expect(elements['token-detail'].textContent).toContain('输入 1M');
    expect(elements['status-text'].textContent).toContain('数据生成于');
    expect(writes).toEqual([['loongsuite-pilot.dashboard.language', 'zh-CN']]);
    expect(fetch).toHaveBeenCalledTimes(1);
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
      const currentLanguage = 'en';
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
    expect(dashboardHtml).toContain("${translate('inputLabel')} ${tokenCount(today.inputTokens)}");
    expect(dashboardHtml).toContain("${translate('outputLabel')} ${tokenCount(today.outputTokens)}");
    expect(dashboardHtml).toContain("${translate('cacheReadLabel')} ${tokenCount(today.cacheReadTokens)}");
    expect(dashboardHtml).toContain("translate('tokenLabel'), tokenCount");
    expect(dashboardHtml).toContain("translate('sessionLabel'), count");
    expect(dashboardHtml).toContain("'model', 'totalTokens', tokenCount");
    expect(dashboardHtml).toContain("'provider', 'totalTokens', tokenCount");
    expect(dashboardHtml).toContain("$('sessions').textContent = count(today.totalSessions)");
    expect(dashboardHtml).toContain('${count(agent.sessions)}');
    expect(dashboardHtml).toContain('${count(agent.events)}');
  });
});
