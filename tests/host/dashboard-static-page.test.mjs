// Explicit retained browser-JavaScript contracts. Optional host suite only;
// no Node dependency enters the Rust product or default Cargo validation.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
const dashboardHtml = readFileSync(resolve('assets/dashboard/index.html'), 'utf8');
const dashboardScript = dashboardHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
function dashboardFunctionSource(name) {
  const match = dashboardScript.match(new RegExp(`function ${name}\\(([^)]*)\\) \\{([\\s\\S]*?)\\n    \\}`));
  expect(match, `${name} should be present in the dashboard script`).not.toBeNull();
  return `function ${name}(${match[1]}) {${match[2]}\n    }`;
}

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

  it('places a decorative language icon between the label text and select', () => {
    const languageControl = dashboardHtml.match(
      /<label class="status"><span data-i18n="languageLabel">语言<\/span>([\s\S]*?)<\/label>/,
    )?.[0];
    expect(languageControl).toBeTruthy();

    const labelIndex = languageControl.indexOf('data-i18n="languageLabel"');
    const iconIndex = languageControl.indexOf('<svg class="language-icon"');
    const selectIndex = languageControl.indexOf('<select id="language-select"');
    expect(labelIndex).toBeLessThan(iconIndex);
    expect(iconIndex).toBeLessThan(selectIndex);
    expect(languageControl).toMatch(
      /<svg class="language-icon" aria-hidden="true" focusable="false"[^>]*stroke="currentColor"/,
    );
    expect(languageControl).not.toContain('<title>');
    expect(languageControl).toContain(
      '<select id="language-select" data-i18n-aria-label="languageAriaLabel" aria-label="界面语言">',
    );
    expect(dashboardHtml).toContain(
      '.language-icon { width: 14px; height: 14px; flex: 0 0 14px; color: inherit; }',
    );
  });

  it('detects zh browser preferences and otherwise defaults to English', () => {
    const normalizeLanguage = Function(`return (${dashboardFunctionSource('normalizeLanguage')});`)();
    const detectBrowserLanguage = Function(
      'normalizeLanguage',
      `return (${dashboardFunctionSource('detectBrowserLanguage')});`,
    )(normalizeLanguage);

    expect(normalizeLanguage('zh')).toBe('zh-CN');
    expect(normalizeLanguage('zh-Hant-TW')).toBe('zh-CN');
    expect(normalizeLanguage(' zh-TW ')).toBe('zh-CN');
    expect(normalizeLanguage('en-US')).toBe('en');
    expect(detectBrowserLanguage(['en-US', 'zh-CN'], 'zh-CN')).toBe('en');
    expect(detectBrowserLanguage(['zh-TW', 'en-US'], 'en-US')).toBe('zh-CN');
    expect(detectBrowserLanguage(['', '  ', 'fr-FR'], 'zh-CN')).toBe('en');
    expect(detectBrowserLanguage(['fr-FR'], 'fr-FR')).toBe('en');
    expect(detectBrowserLanguage([], 'zh-SG')).toBe('zh-CN');
    expect(detectBrowserLanguage(undefined, 'en-US')).toBe('en');
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
        this.classList = { toggle: vi.fn(), add: vi.fn(), remove: vi.fn() };
        this.listeners = {};
        this.attributes = {};
        this.style = {};
        this._innerHTML = '';
        this.innerHTMLWrites = 0;
        this.trendBars = [];
        this.tooltip = null;
        this.textContent = '';
        this.value = '';
      }
      get innerHTML() { return this._innerHTML; }
      set innerHTML(value) {
        this._innerHTML = value;
        this.innerHTMLWrites += 1;
        this.trendBars = [];
        this.tooltip = null;
        if (!value.includes('class="trend-bar"')) return;

        const wrap = new FakeElement();
        const tooltip = new FakeElement();
        wrap.getBoundingClientRect = () => ({ left: 0, right: 600, height: 160 });
        wrap.querySelector = selector => selector === '.trend-tooltip' ? tooltip : null;
        tooltip.getBoundingClientRect = () => ({ width: 120, height: 40 });
        this.tooltip = tooltip;

        for (const buttonMatch of value.matchAll(/<button type="button" class="trend-bar"([^>]*)>/g)) {
          const attributes = Object.fromEntries(
            [...buttonMatch[1].matchAll(/([\w-]+)="([^"]*)"/g)]
              .map(([, name, attributeValue]) => [name, attributeValue]),
          );
          const bar = new FakeElement({
            day: attributes['data-day'],
            displayDay: attributes['data-display-day'],
            label: attributes['data-label'],
            formattedValue: attributes['data-formatted-value'],
          });
          const fill = new FakeElement();
          fill.getBoundingClientRect = () => ({ left: 20, width: 10, top: 60 });
          bar.attributes = attributes;
          bar.closest = selector => selector === '.trend-wrap' ? wrap : null;
          bar.querySelector = selector => selector === '.trend-bar-fill' ? fill : null;
          this.trendBars.push(bar);
        }
      }
      addEventListener(name, handler) { this.listeners[name] = handler; }
      setAttribute(name, value) { this.attributes[name] = value; }
      contains() { return false; }
      matches() { return false; }
      closest() { return null; }
      querySelector() { return null; }
      querySelectorAll(selector) { return selector === '.trend-bar' ? this.trendBars : []; }
      getBoundingClientRect() { return { left: 0, right: 0, top: 0, width: 0, height: 0 }; }
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
      innerWidth: 1280,
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
            agentShares: [{
              agentType: '<img src=x onerror=alert(1)>',
              sessions: 1,
              events: 2,
              tokens: 1500000,
              share: 0.5,
            }],
            modelShares: [{
              model: '<script>alert(1)</script>',
              totalTokens: 1500000,
              share: 1,
            }],
            providerShares: [{ provider: 'anthropic', totalTokens: 1500000, share: 1 }],
            repoShares: [{ repo: 'org/repo', sessions: 2, events: 3 }],
          },
        },
        dailyTokens: [{ day: '2026-08-13', value: 1500000 }],
        dailySessions: [{ day: '2026-08-13', value: 2 }],
      }),
    });
    await new Promise(resolveWait => setImmediate(resolveWait));

    expect(elements['agent-grid'].innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(elements['agent-grid'].innerHTML).not.toContain('<img src=x');
    expect(elements['agent-grid'].innerHTML).toContain('% of all Agent events today');
    expect(elements.models.innerHTML).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(elements.models.innerHTML).not.toContain('<script>alert(1)</script>');
    expect(elements.providers.innerHTML).toContain('anthropic');
    expect(elements.repos.innerHTML).toContain('2 sessions');
    expect(elements.repos.innerHTML).toContain('3 events');
    expect(elements['token-trend'].innerHTML).toContain('aria-label="30-day Token trend"');
    const englishTokenBar = elements['token-trend'].trendBars[0];
    expect(englishTokenBar.attributes['aria-label']).toContain('Aug');
    expect(englishTokenBar.attributes['aria-label']).toContain('Token 1.5M');
    englishTokenBar.listeners.mouseenter({ currentTarget: englishTokenBar });
    expect(elements['token-trend'].tooltip.innerHTML).toContain('Aug');
    expect(elements['token-trend'].tooltip.innerHTML).toContain('Token 1.5M');
    expect(elements['token-detail'].textContent).toContain('Input 1M');
    expect(elements['status-text'].textContent).toContain('Generated at');
    expect(fetch).toHaveBeenCalledTimes(1);
    const englishRenderCounts = {
      models: elements.models.innerHTMLWrites,
      providers: elements.providers.innerHTMLWrites,
      repos: elements.repos.innerHTMLWrites,
    };

    elements['language-select'].listeners.change({ target: { value: 'zh-CN' } });

    expect(document.documentElement.lang).toBe('zh-CN');
    expect(heading.textContent).toBe('Agent 分布');
    expect(elements['agent-grid'].innerHTML).toContain('事件数占比');
    expect(elements['agent-grid'].innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(elements['token-trend'].innerHTML).toContain('aria-label="最近 30 天 Token趋势"');
    const chineseTokenBar = elements['token-trend'].trendBars[0];
    expect(chineseTokenBar.attributes['aria-label']).toContain('2026年');
    expect(chineseTokenBar.attributes['aria-label']).toContain('Token 1.5M');
    chineseTokenBar.listeners.mouseenter({ currentTarget: chineseTokenBar });
    expect(elements['token-trend'].tooltip.innerHTML).toContain('2026年');
    expect(elements['token-trend'].tooltip.innerHTML).toContain('Token 1.5M');
    expect(elements.models.innerHTML).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(elements.providers.innerHTML).toContain('anthropic');
    expect(elements.repos.innerHTML).toContain('2 个 Session');
    expect(elements.repos.innerHTML).toContain('3 个 Event');
    expect(elements.models.innerHTMLWrites).toBeGreaterThan(englishRenderCounts.models);
    expect(elements.providers.innerHTMLWrites).toBeGreaterThan(englishRenderCounts.providers);
    expect(elements.repos.innerHTMLWrites).toBeGreaterThan(englishRenderCounts.repos);
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
