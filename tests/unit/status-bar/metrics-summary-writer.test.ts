import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createTempDir, cleanupTempDir } from '../../helpers/fixture-builder.js';
import { MetricsSummaryWriter } from '../../../src/status-bar/metrics-summary-writer.js';
import type { StatusBarConfig } from '../../../src/types/index.js';

const logger = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => logger,
}));

function makeConfig(overrides: Partial<StatusBarConfig> = {}): StatusBarConfig {
  return {
    enabled: true,
    metricsSummaryIntervalMs: 60_000,
    runtimeRefreshIntervalMs: 30_000,
    ...overrides,
  };
}

function today(): string {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

function currentDayScanBytes(): number[] {
  return logger.debug.mock.calls
    .filter(([message]) => message === 'metrics current-day files refreshed')
    .map(([, details]) => (details as { bytesRead: number }).bytesRead);
}

function makeLlmResponse(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'event.id': `evt-${Math.random().toString(36).slice(2)}`,
    'event.name': 'llm.response',
    'gen_ai.session.id': 'session-1',
    'gen_ai.agent.type': 'claude-code',
    'gen_ai.request.model': 'claude-opus-4-6',
    'gen_ai.usage.input_tokens': '1000',
    'gen_ai.usage.output_tokens': '200',
    'gen_ai.usage.cache_read.input_tokens': '500',
    'gen_ai.usage.cache_creation.input_tokens': '100',
    'gen_ai.usage.total_tokens': '1200',
    'time_unix_nano': `${Date.now()}000000`,
    ...overrides,
  };
}

function makeLlmRequest(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'event.id': `evt-${Math.random().toString(36).slice(2)}`,
    'event.name': 'llm.request',
    'gen_ai.session.id': 'session-1',
    'gen_ai.agent.type': 'claude-code',
    'gen_ai.request.model': 'claude-opus-4-6',
    'time_unix_nano': `${Date.now()}000000`,
    ...overrides,
  };
}

function makeToolCall(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'event.id': `evt-${Math.random().toString(36).slice(2)}`,
    'event.name': 'tool.call',
    'gen_ai.session.id': 'session-1',
    'gen_ai.agent.type': 'claude-code',
    'gen_ai.tool.name': 'Read',
    'time_unix_nano': `${Date.now()}000000`,
    ...overrides,
  };
}

async function writeJsonlFile(dir: string, filename: string, records: Record<string, string>[]): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const content = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  await fs.writeFile(path.join(dir, filename), content);
}

describe('MetricsSummaryWriter', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await createTempDir('metrics-summary-test-');
    await fs.mkdir(path.join(tmpDir, 'logs', 'output'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'cache'), { recursive: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await cleanupTempDir(tmpDir);
  });

  it('generates metrics-summary.json from JSONL files', async () => {
    const outputDir = path.join(tmpDir, 'logs', 'output');
    await writeJsonlFile(outputDir, `claude-code-${today()}.jsonl`, [
      makeLlmRequest(),
      makeLlmResponse(),
      makeToolCall(),
      makeToolCall(),
    ]);

    const writer = new MetricsSummaryWriter(tmpDir, makeConfig());
    await writer.refresh();

    const summaryPath = path.join(tmpDir, 'logs', 'metrics-summary.json');
    const summary = JSON.parse(await fs.readFile(summaryPath, 'utf8'));

    expect(summary.version).toBe(1);
    expect(summary.generatedAt).toBeTruthy();

    const todayRange = summary.ranges.today;
    expect(todayRange.totalTokens).toBe(1200);
    expect(todayRange.inputTokens).toBe(1000);
    expect(todayRange.outputTokens).toBe(200);
    expect(todayRange.cacheReadTokens).toBe(500);
    expect(todayRange.totalRequests).toBe(1);
    expect(todayRange.totalToolCalls).toBe(2);
    expect(todayRange.totalEvents).toBe(4);
    expect(todayRange.totalSessions).toBe(1);
  });

  it('reads events from the configured JSONL output directory', async () => {
    const outputDir = path.join(tmpDir, 'custom-jsonl-output');
    await writeJsonlFile(outputDir, `codex-${today()}.jsonl`, [makeLlmResponse()]);

    const writer = new MetricsSummaryWriter(tmpDir, makeConfig(), outputDir);
    await writer.refresh();

    const summaryPath = path.join(tmpDir, 'logs', 'metrics-summary.json');
    const summary = JSON.parse(await fs.readFile(summaryPath, 'utf8'));
    expect(summary.ranges.today.totalTokens).toBe(1200);
    expect(summary.ranges.today.agentShares).toEqual([
      expect.objectContaining({ agentType: 'claude-code', tokens: 1200 }),
    ]);
  });

  it('waits for an in-flight refresh before stopping', async () => {
    const writer = new MetricsSummaryWriter(tmpDir, makeConfig());
    let finishAggregate!: () => void;
    const aggregate = new Promise<void>(resolve => { finishAggregate = resolve; });
    vi.spyOn(writer as unknown as { aggregate: () => Promise<void> }, 'aggregate')
      .mockReturnValue(aggregate);

    const refresh = writer.refresh();
    let stopped = false;
    const stop = writer.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    finishAggregate();
    await expect(refresh).resolves.toBeUndefined();
    await expect(stop).resolves.toBeUndefined();
    expect(stopped).toBe(true);
    await expect(writer.refresh()).resolves.toBeUndefined();
  });

  it('deduplicates sessions correctly', async () => {
    const outputDir = path.join(tmpDir, 'logs', 'output');
    await writeJsonlFile(outputDir, `claude-code-${today()}.jsonl`, [
      makeLlmRequest({ 'gen_ai.session.id': 'session-A' }),
      makeLlmResponse({ 'gen_ai.session.id': 'session-A' }),
      makeLlmRequest({ 'gen_ai.session.id': 'session-B' }),
      makeLlmResponse({ 'gen_ai.session.id': 'session-B' }),
      makeLlmRequest({ 'gen_ai.session.id': 'session-A' }),
      makeLlmResponse({ 'gen_ai.session.id': 'session-A' }),
    ]);

    const writer = new MetricsSummaryWriter(tmpDir, makeConfig());
    await writer.refresh();

    const summary = JSON.parse(await fs.readFile(path.join(tmpDir, 'logs', 'metrics-summary.json'), 'utf8'));
    expect(summary.ranges.today.totalSessions).toBe(2);
  });

  it('groups by model correctly', async () => {
    const outputDir = path.join(tmpDir, 'logs', 'output');
    await writeJsonlFile(outputDir, `claude-code-${today()}.jsonl`, [
      makeLlmResponse({
        'gen_ai.request.model': 'claude-opus-4-6',
        'gen_ai.usage.input_tokens': '800', 'gen_ai.usage.output_tokens': '100',
        'gen_ai.usage.cache_read.input_tokens': '0', 'gen_ai.usage.cache_creation.input_tokens': '0',
        'gen_ai.usage.total_tokens': '1000',
      }),
      makeLlmResponse({
        'gen_ai.request.model': 'claude-sonnet-4-6',
        'gen_ai.usage.input_tokens': '400', 'gen_ai.usage.output_tokens': '100',
        'gen_ai.usage.cache_read.input_tokens': '0', 'gen_ai.usage.cache_creation.input_tokens': '0',
        'gen_ai.usage.total_tokens': '500',
      }),
      makeLlmResponse({
        'gen_ai.request.model': 'claude-opus-4-6',
        'gen_ai.usage.input_tokens': '1800', 'gen_ai.usage.output_tokens': '200',
        'gen_ai.usage.cache_read.input_tokens': '0', 'gen_ai.usage.cache_creation.input_tokens': '0',
        'gen_ai.usage.total_tokens': '2000',
      }),
    ]);

    const writer = new MetricsSummaryWriter(tmpDir, makeConfig());
    await writer.refresh();

    const summary = JSON.parse(await fs.readFile(path.join(tmpDir, 'logs', 'metrics-summary.json'), 'utf8'));
    const models = summary.ranges.today.modelShares;
    expect(models.length).toBe(2);
    expect(models[0].model).toBe('claude-opus-4-6');
    expect(models[0].totalTokens).toBe(3000);
    expect(models[1].model).toBe('claude-sonnet-4-6');
    expect(models[1].totalTokens).toBe(500);
  });

  it('groups by agent type correctly', async () => {
    const outputDir = path.join(tmpDir, 'logs', 'output');
    await writeJsonlFile(outputDir, `claude-code-${today()}.jsonl`, [
      makeLlmRequest({ 'gen_ai.agent.type': 'claude-code' }),
      makeLlmResponse({ 'gen_ai.agent.type': 'claude-code' }),
    ]);
    await writeJsonlFile(outputDir, `cursor-${today()}.jsonl`, [
      makeLlmRequest({ 'gen_ai.agent.type': 'cursor' }),
      makeLlmResponse({ 'gen_ai.agent.type': 'cursor' }),
      makeToolCall({ 'gen_ai.agent.type': 'cursor' }),
    ]);

    const writer = new MetricsSummaryWriter(tmpDir, makeConfig());
    await writer.refresh();

    const summary = JSON.parse(await fs.readFile(path.join(tmpDir, 'logs', 'metrics-summary.json'), 'utf8'));
    const agents = summary.ranges.today.agentShares;
    expect(agents.length).toBe(2);

    const cursor = agents.find((a: { agentType: string }) => a.agentType === 'cursor');
    const claude = agents.find((a: { agentType: string }) => a.agentType === 'claude-code');
    expect(cursor.events).toBe(3);
    expect(claude.events).toBe(2);
    expect(summary.ranges.today.totalSessions).toBe(1);
  });

  it('incremental scan: only reads new lines on second refresh', async () => {
    const outputDir = path.join(tmpDir, 'logs', 'output');
    const resp1 = makeLlmResponse({
      'gen_ai.usage.input_tokens': '800', 'gen_ai.usage.output_tokens': '200',
      'gen_ai.usage.cache_read.input_tokens': '0', 'gen_ai.usage.cache_creation.input_tokens': '0',
      'gen_ai.usage.total_tokens': '1000',
    });
    await writeJsonlFile(outputDir, `claude-code-${today()}.jsonl`, [resp1]);

    const writer = new MetricsSummaryWriter(tmpDir, makeConfig());
    await writer.refresh();

    let summary = JSON.parse(await fs.readFile(path.join(tmpDir, 'logs', 'metrics-summary.json'), 'utf8'));
    expect(summary.ranges.today.totalTokens).toBe(1000);

    // Append more data
    const resp2 = makeLlmResponse({
      'gen_ai.usage.input_tokens': '400', 'gen_ai.usage.output_tokens': '100',
      'gen_ai.usage.cache_read.input_tokens': '0', 'gen_ai.usage.cache_creation.input_tokens': '0',
      'gen_ai.usage.total_tokens': '500',
    });
    const filePath = path.join(outputDir, `claude-code-${today()}.jsonl`);
    await fs.appendFile(filePath, JSON.stringify(resp2) + '\n');

    await writer.refresh();

    summary = JSON.parse(await fs.readFile(path.join(tmpDir, 'logs', 'metrics-summary.json'), 'utf8'));
    expect(summary.ranges.today.totalTokens).toBe(1500);
    expect(summary.ranges.today.totalSessions).toBe(1);

    await writer.refresh();

    const scanBytes = currentDayScanBytes();
    expect(scanBytes).toHaveLength(3);
    expect(scanBytes[0]).toBeGreaterThan(0);
    expect(scanBytes[1]).toBe(Buffer.byteLength(JSON.stringify(resp2) + '\n'));
    expect(scanBytes[2]).toBe(0);
  });

  it('restores current-day aggregate state across writer restarts without rescanning', async () => {
    const outputDir = path.join(tmpDir, 'logs', 'output');
    await writeJsonlFile(outputDir, `codex-${today()}.jsonl`, [
      makeLlmRequest({ 'gen_ai.agent.type': 'codex' }),
      makeLlmResponse({ 'gen_ai.agent.type': 'codex' }),
    ]);

    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();
    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();

    const summary = JSON.parse(await fs.readFile(path.join(tmpDir, 'logs', 'metrics-summary.json'), 'utf8'));
    expect(summary.ranges.today.totalTokens).toBe(1200);
    expect(summary.ranges.today.totalEvents).toBe(2);
    expect(currentDayScanBytes()).toEqual([
      expect.any(Number),
      0,
    ]);
  });

  it('does not commit a trailing partial JSONL record', async () => {
    const outputDir = path.join(tmpDir, 'logs', 'output');
    const filePath = path.join(outputDir, `codex-${today()}.jsonl`);
    const first = makeLlmResponse({ 'gen_ai.usage.total_tokens': '1000' });
    const second = makeLlmResponse({ 'gen_ai.usage.total_tokens': '500' });
    const firstLine = JSON.stringify(first) + '\n';
    const secondLine = JSON.stringify(second);
    const splitAt = Math.floor(secondLine.length / 2);
    await fs.writeFile(filePath, firstLine + secondLine.slice(0, splitAt));

    const writer = new MetricsSummaryWriter(tmpDir, makeConfig());
    await writer.refresh();

    let summary = JSON.parse(await fs.readFile(path.join(tmpDir, 'logs', 'metrics-summary.json'), 'utf8'));
    expect(summary.ranges.today.totalTokens).toBe(1000);

    const statePath = path.join(tmpDir, 'cache', 'metrics-current-day-state.json');
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    expect(state.files[0].offset).toBe(Buffer.byteLength(firstLine));

    await fs.appendFile(filePath, secondLine.slice(splitAt) + '\n');
    await writer.refresh();

    summary = JSON.parse(await fs.readFile(path.join(tmpDir, 'logs', 'metrics-summary.json'), 'utf8'));
    expect(summary.ranges.today.totalTokens).toBe(1500);
    expect(summary.ranges.today.totalEvents).toBe(2);
  });

  it('rebuilds only a replaced current-day file', async () => {
    const outputDir = path.join(tmpDir, 'logs', 'output');
    const codexPath = path.join(outputDir, `codex-${today()}.jsonl`);
    const claudePath = path.join(outputDir, `claude-code-${today()}.jsonl`);
    await writeJsonlFile(outputDir, path.basename(codexPath), [
      makeLlmResponse({
        'gen_ai.agent.type': 'codex',
        'gen_ai.session.id': 'codex-old',
        'gen_ai.usage.total_tokens': '1000',
      }),
    ]);
    await writeJsonlFile(outputDir, path.basename(claudePath), [
      makeLlmResponse({
        'gen_ai.agent.type': 'claude-code',
        'gen_ai.session.id': 'claude-stable',
        'gen_ai.usage.total_tokens': '2000',
      }),
    ]);

    const writer = new MetricsSummaryWriter(tmpDir, makeConfig());
    await writer.refresh();

    const replacementPath = `${codexPath}.replacement`;
    await fs.writeFile(replacementPath, JSON.stringify(makeLlmResponse({
      'gen_ai.agent.type': 'codex',
      'gen_ai.session.id': 'codex-new',
      'gen_ai.usage.total_tokens': '500',
    })) + '\n');
    await fs.rename(replacementPath, codexPath);
    await writer.refresh();

    const summary = JSON.parse(await fs.readFile(path.join(tmpDir, 'logs', 'metrics-summary.json'), 'utf8'));
    expect(summary.ranges.today.totalTokens).toBe(2500);
    expect(summary.ranges.today.totalEvents).toBe(2);
    expect(summary.ranges.today.totalSessions).toBe(2);
  });

  it('rebuilds a current-day file after it is truncated in place', async () => {
    const outputDir = path.join(tmpDir, 'logs', 'output');
    const filePath = path.join(outputDir, `codex-${today()}.jsonl`);
    const original = makeLlmResponse({
      'gen_ai.session.id': 'old-session',
      'gen_ai.usage.total_tokens': '123456',
    });
    const replacement = makeLlmResponse({
      'gen_ai.session.id': 'new-session',
      'gen_ai.usage.total_tokens': '50',
    });
    await fs.writeFile(filePath, JSON.stringify(original) + '\n');

    const writer = new MetricsSummaryWriter(tmpDir, makeConfig());
    await writer.refresh();
    await fs.truncate(filePath, 0);
    await fs.writeFile(filePath, JSON.stringify(replacement) + '\n');
    await writer.refresh();

    const summary = JSON.parse(await fs.readFile(path.join(tmpDir, 'logs', 'metrics-summary.json'), 'utf8'));
    expect(summary.ranges.today.totalTokens).toBe(50);
    expect(summary.ranges.today.totalEvents).toBe(1);
    expect(summary.ranges.today.totalSessions).toBe(1);
  });

  it('falls back to one full rebuild when current-day state is corrupt', async () => {
    const outputDir = path.join(tmpDir, 'logs', 'output');
    await writeJsonlFile(outputDir, `codex-${today()}.jsonl`, [
      makeLlmResponse({ 'gen_ai.usage.total_tokens': '1000' }),
    ]);

    const writer = new MetricsSummaryWriter(tmpDir, makeConfig());
    await writer.refresh();
    await fs.writeFile(
      path.join(tmpDir, 'cache', 'metrics-current-day-state.json'),
      JSON.stringify({ version: 1, day: today(), files: [{ broken: true }] }),
    );
    await writer.refresh();

    const summary = JSON.parse(await fs.readFile(path.join(tmpDir, 'logs', 'metrics-summary.json'), 'utf8'));
    expect(summary.ranges.today.totalTokens).toBe(1000);
    expect(summary.ranges.today.totalEvents).toBe(1);
    expect(currentDayScanBytes().at(-1)).toBeGreaterThan(0);
  });

  it('finalizes the previous day including data appended after its last refresh', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T12:00:00'));
    const outputDir = path.join(tmpDir, 'logs', 'output');
    const previousDayPath = path.join(outputDir, 'codex-2026-07-30.jsonl');
    const first = makeLlmResponse({ 'gen_ai.usage.total_tokens': '1000' });
    const second = makeLlmResponse({ 'gen_ai.usage.total_tokens': '500' });
    await fs.writeFile(previousDayPath, JSON.stringify(first) + '\n');

    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();
    await fs.appendFile(previousDayPath, JSON.stringify(second) + '\n');

    vi.setSystemTime(new Date('2026-07-31T00:01:00'));
    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();

    const summary = JSON.parse(await fs.readFile(path.join(tmpDir, 'logs', 'metrics-summary.json'), 'utf8'));
    expect(summary.ranges.today.totalTokens).toBe(0);
    expect(summary.ranges.sevenDays.totalTokens).toBe(1500);

    const digest = JSON.parse(await fs.readFile(
      path.join(tmpDir, 'cache', 'metrics-daily-digest.json'),
      'utf8',
    ));
    expect(digest.days['2026-07-30'].tokens).toBe(1500);

    const currentState = JSON.parse(await fs.readFile(
      path.join(tmpDir, 'cache', 'metrics-current-day-state.json'),
      'utf8',
    ));
    expect(currentState.day).toBe('2026-07-31');
  });

  it('handles empty output directory gracefully', async () => {
    const writer = new MetricsSummaryWriter(tmpDir, makeConfig());
    await writer.refresh();

    const summary = JSON.parse(await fs.readFile(path.join(tmpDir, 'logs', 'metrics-summary.json'), 'utf8'));
    expect(summary.ranges.today.totalTokens).toBe(0);
    expect(summary.ranges.today.totalSessions).toBe(0);
    expect(summary.dailyTokens).toBeInstanceOf(Array);
  });

  it('builds dailyTokens trend data', async () => {
    const outputDir = path.join(tmpDir, 'logs', 'output');
    await writeJsonlFile(outputDir, `claude-code-${today()}.jsonl`, [
      makeLlmResponse({ 'gen_ai.usage.total_tokens': '5000' }),
    ]);

    const writer = new MetricsSummaryWriter(tmpDir, makeConfig());
    await writer.refresh();

    const summary = JSON.parse(await fs.readFile(path.join(tmpDir, 'logs', 'metrics-summary.json'), 'utf8'));
    expect(summary.dailyTokens.length).toBe(30);

    const todayPoint = summary.dailyTokens.find((p: { day: string }) => p.day === today());
    expect(todayPoint).toBeTruthy();
    expect(todayPoint.value).toBe(5000);
  });

  it('aggregates provider shares correctly', async () => {
    const outputDir = path.join(tmpDir, 'logs', 'output');
    await writeJsonlFile(outputDir, `claude-code-${today()}.jsonl`, [
      makeLlmResponse({ 'gen_ai.provider.name': 'anthropic', 'gen_ai.usage.total_tokens': '3000' }),
      makeLlmResponse({ 'gen_ai.provider.name': 'anthropic', 'gen_ai.usage.total_tokens': '2000' }),
      makeLlmResponse({ 'gen_ai.provider.name': 'openai', 'gen_ai.usage.total_tokens': '1000' }),
    ]);

    const writer = new MetricsSummaryWriter(tmpDir, makeConfig());
    await writer.refresh();

    const summary = JSON.parse(await fs.readFile(path.join(tmpDir, 'logs', 'metrics-summary.json'), 'utf8'));
    const providers = summary.ranges.today.providerShares;
    expect(providers.length).toBe(2);
    expect(providers[0].provider).toBe('anthropic');
    expect(providers[0].totalTokens).toBeGreaterThan(providers[1].totalTokens);
    expect(providers[1].provider).toBe('openai');
  });

  it('aggregates repo shares correctly', async () => {
    const outputDir = path.join(tmpDir, 'logs', 'output');
    await writeJsonlFile(outputDir, `claude-code-${today()}.jsonl`, [
      makeLlmRequest({ 'git.repo': 'sls/loongsuite-pilot', 'gen_ai.session.id': 's1' }),
      makeLlmResponse({ 'git.repo': 'sls/loongsuite-pilot', 'gen_ai.session.id': 's1' }),
      makeLlmRequest({ 'git.repo': 'foo/bar', 'gen_ai.session.id': 's2' }),
      makeLlmResponse({ 'git.repo': 'foo/bar', 'gen_ai.session.id': 's2' }),
      makeToolCall({ 'git.repo': 'sls/loongsuite-pilot', 'gen_ai.session.id': 's1' }),
    ]);

    const writer = new MetricsSummaryWriter(tmpDir, makeConfig());
    await writer.refresh();

    const summary = JSON.parse(await fs.readFile(path.join(tmpDir, 'logs', 'metrics-summary.json'), 'utf8'));
    const repos = summary.ranges.today.repoShares;
    expect(repos.length).toBe(2);

    const pilot = repos.find((r: { repo: string }) => r.repo === 'sls/loongsuite-pilot');
    expect(pilot.sessions).toBe(1);
    expect(pilot.events).toBe(3);

    const foobar = repos.find((r: { repo: string }) => r.repo === 'foo/bar');
    expect(foobar.sessions).toBe(1);
    expect(foobar.events).toBe(2);
  });
});
