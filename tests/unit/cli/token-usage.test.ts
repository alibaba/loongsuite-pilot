import { describe, expect, it } from 'vitest';
import {
  parseTokenUsageArgs,
  renderTokenUsage,
  type TokenUsageViewData,
} from '../../../src/cli/token-usage.js';

function makeViewData(): TokenUsageViewData {
  return {
    dataDir: '/tmp/loongsuite-pilot',
    summaryPath: '/tmp/loongsuite-pilot/logs/metrics-summary.json',
    runtimePath: '/tmp/loongsuite-pilot/logs/runtime.json',
    runtimeAlive: true,
    now: new Date('2026-06-24T11:35:00.000Z'),
    runtime: {
      status: 'active',
      packageVersion: '1.2.3',
      pid: 1234,
      updatedAt: '2026-06-24T11:34:30.000Z',
    },
    summary: {
      version: 1,
      packageVersion: '1.2.3',
      generatedAt: '2026-06-24T11:34:00.000Z',
      ranges: {
        today: {
          totalTokens: 1530,
          inputTokens: 1200,
          outputTokens: 330,
          cacheReadTokens: 600,
          cacheCreationTokens: 0,
          totalSessions: 2,
          totalRequests: 3,
          totalToolCalls: 4,
          totalEvents: 9,
          providerShares: [
            { provider: 'openai', totalTokens: 1200, share: 0.78 },
            { provider: 'anthropic', totalTokens: 330, share: 0.22 },
          ],
          modelShares: [
            { model: 'gpt-5.5', totalTokens: 1530, inputTokens: 1200, cacheReadTokens: 600, share: 1 },
          ],
          agentShares: [
            { agentType: 'codex', sessions: 2, events: 9, tokens: 1530, share: 1 },
          ],
          repoShares: [
            { repo: 'sls/loongsuite-pilot', sessions: 2, events: 9 },
          ],
        },
      },
      dailyTokens: [
        { day: '2026-06-18', value: 0 },
        { day: '2026-06-19', value: 10 },
        { day: '2026-06-20', value: 20 },
        { day: '2026-06-21', value: 30 },
        { day: '2026-06-22', value: 40 },
        { day: '2026-06-23', value: 50 },
        { day: '2026-06-24', value: 1530 },
      ],
      dailySessions: [
        { day: '2026-06-18', value: 0 },
        { day: '2026-06-19', value: 1 },
        { day: '2026-06-20', value: 1 },
        { day: '2026-06-21', value: 1 },
        { day: '2026-06-22', value: 1 },
        { day: '2026-06-23', value: 1 },
        { day: '2026-06-24', value: 2 },
      ],
    },
  };
}

describe('token-usage CLI', () => {
  it('parses range, data dir, and output mode options', () => {
    const parsed = parseTokenUsageArgs(
      ['--once', '--range', '30d', '--data-dir', '~/pilot-data', '--no-color'],
      {},
      true,
    );

    expect(parsed.error).toBeUndefined();
    expect(parsed.options).toMatchObject({
      range: 'thirtyDays',
      dataDir: '~/pilot-data',
      color: false,
    });
  });

  it('prints once by default and only colors tty output', () => {
    expect(parseTokenUsageArgs([], {}, true).options.color).toBe(true);
    expect(parseTokenUsageArgs([], {}, false).options.color).toBe(false);
    expect(parseTokenUsageArgs([], { NO_COLOR: '' }, true).options.color).toBe(false);
  });

  it('renders token usage from metrics summary and runtime data', () => {
    const output = renderTokenUsage(makeViewData(), {
      range: 'today',
      color: false,
      help: false,
    }, 100);

    expect(output).toContain('LoongSuite Pilot Token Usage');
    expect(output).toContain('active pid 1234');
    expect(output).toContain('Tokens');
    expect(output).toContain('1.5K');
    expect(output).toMatch(/Cache read\s+600\s+50%/);
    expect(output).toContain('Providers');
    expect(output).toContain('openai');
    expect(output).toContain('Agents');
    expect(output).toContain('codex');
    expect(output).toContain('Token Trend (7d)');
  });

  it('keeps table columns aligned when color is enabled', () => {
    const output = renderTokenUsage(makeViewData(), {
      range: 'today',
      color: true,
      help: false,
    }, 100);
    const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
    const lines = plain.split('\n');

    const providerHeader = lines.find(line => line.includes('Provider') && line.includes('Usage'));
    const openai = lines.find(line => line.includes('openai'));
    const modelHeader = lines.find(line => line.includes('Model') && line.includes('Usage'));
    const model = lines.find(line => line.includes('gpt-5.5'));
    const agentHeader = lines.find(line => line.includes('Agent') && line.includes('Activity'));
    const agent = lines.find(line => line.includes('codex'));
    const repoHeader = lines.find(line => line.includes('Repository') && line.includes('Events'));
    const tokenBreakdown = lines[lines.indexOf('Token Breakdown') + 1];
    expect(providerHeader).toBeTruthy();
    expect(openai).toBeTruthy();
    expect(openai!.indexOf('[')).toBe(providerHeader!.indexOf('Usage'));
    expect(tokenBreakdown.indexOf('[')).toBe(providerHeader!.indexOf('Usage'));
    expect(modelHeader).toBeTruthy();
    expect(model).toBeTruthy();
    expect(model!.indexOf('[')).toBe(modelHeader!.indexOf('Usage'));
    expect(modelHeader!.indexOf('Usage')).toBe(providerHeader!.indexOf('Usage'));
    expect(agentHeader).toBeTruthy();
    expect(agent).toBeTruthy();
    expect(agent!.indexOf('[')).toBe(agentHeader!.indexOf('Activity'));
    expect(agentHeader!.indexOf('Activity')).toBe(providerHeader!.indexOf('Usage'));
    expect(repoHeader).toBeTruthy();
    expect(repoHeader!.indexOf('Events')).toBe(agentHeader!.indexOf('Events'));

    const summaryLabel = lines.find(line => line.includes('Tokens') && line.includes('Input') && line.includes('Output'));
    const summaryValue = lines[lines.indexOf(summaryLabel!) + 1];
    expect(summaryValue.indexOf('1.5K')).toBe(summaryLabel!.indexOf('Tokens'));
    expect(summaryValue.indexOf('1.2K')).toBe(summaryLabel!.indexOf('Input'));
  });

  it('renders a useful empty state when metrics are missing', () => {
    const data = makeViewData();
    data.summary = null;
    data.summaryError = 'not found';

    const output = renderTokenUsage(data, {
      range: 'today',
      color: false,
      help: false,
    }, 100);

    expect(output).toContain('No metrics summary found yet.');
    expect(output).not.toContain('/tmp/loongsuite-pilot/logs/metrics-summary.json');
  });
});
