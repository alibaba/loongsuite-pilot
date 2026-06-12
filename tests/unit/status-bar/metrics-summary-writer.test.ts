import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createTempDir, cleanupTempDir } from '../../helpers/fixture-builder.js';
import { MetricsSummaryWriter } from '../../../src/status-bar/metrics-summary-writer.js';
import type { StatusBarConfig } from '../../../src/types/index.js';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
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
    tmpDir = await createTempDir('metrics-summary-test-');
    await fs.mkdir(path.join(tmpDir, 'logs', 'output'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'cache'), { recursive: true });
  });

  afterEach(async () => {
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
