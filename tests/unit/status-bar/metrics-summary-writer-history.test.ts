import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createTempDir, cleanupTempDir } from '../../helpers/fixture-builder.js';
import { MetricsSummaryWriter } from '../../../src/status-bar/metrics-summary-writer.js';
import type { StatusBarConfig } from '../../../src/types/index.js';

const logger = vi.hoisted(() => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../../../src/utils/logger.js', () => ({ createLogger: () => logger }));

function makeConfig(): StatusBarConfig {
  return { enabled: true, metricsSummaryIntervalMs: 60_000, runtimeRefreshIntervalMs: 30_000 };
}

function record(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'event.id': `evt-${Math.random().toString(36).slice(2)}`,
    'event.name': 'llm.response',
    'gen_ai.session.id': 'session-1',
    'gen_ai.agent.type': 'claude-code',
    'gen_ai.request.model': 'claude-opus-4-6',
    'gen_ai.usage.input_tokens': '100',
    'gen_ai.usage.output_tokens': '100',
    'gen_ai.usage.total_tokens': '200',
    ...overrides,
  };
}

async function writeJsonl(dir: string, name: string, rows: Record<string, string>[]): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await fs.writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  return file;
}

async function readSummary(dir: string) {
  return JSON.parse(await fs.readFile(path.join(dir, 'logs', 'metrics-summary.json'), 'utf8'));
}

/**
 * Persist the digest and scan state exactly as an older version left them:
 * scalar totals only, with every segment already scanned to EOF.
 */
async function seedLegacyState(
  dir: string,
  days: Record<string, Record<string, number>>,
  offsets: Record<string, { offset: number; size: number; ino: number }>,
): Promise<void> {
  const cache = path.join(dir, 'cache');
  await fs.mkdir(cache, { recursive: true });
  await fs.writeFile(path.join(cache, 'metrics-daily-digest.json'), JSON.stringify({ version: 1, days }));
  await fs.writeFile(path.join(cache, 'metrics-scan-state.json'), JSON.stringify({ files: offsets }));
}

let tmpDir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = await createTempDir();
});

afterEach(async () => {
  vi.useRealTimers();
  await cleanupTempDir(tmpDir);
});

describe('MetricsSummaryWriter historical breakdown integrity', () => {
  it('keeps numeric accumulators for models and providers named like Object properties', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T12:00:00'));
    const outputDir = path.join(tmpDir, 'logs', 'output');
    await writeJsonl(outputDir, 'claude-code-2026-07-30.jsonl', [
      record({
        'gen_ai.request.model': 'constructor',
        'gen_ai.provider.name': '__proto__',
        'gen_ai.usage.total_tokens': '1000',
      }),
      record({
        'gen_ai.request.model': 'gpt-4o',
        'gen_ai.provider.name': 'constructor',
        'gen_ai.usage.total_tokens': '500',
      }),
    ]);

    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();
    vi.setSystemTime(new Date('2026-07-31T09:00:00'));
    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();

    const range = (await readSummary(tmpDir)).ranges.sevenDays;
    const model = range.modelShares.find((entry: { model: string }) => entry.model === 'constructor');
    expect(model.totalTokens).toBe(1000);
    expect(model.inputTokens).toBe(100);
    expect(range.totalTokens).toBe(1500);

    const prototypeProvider = range.providerShares.find((entry: { provider: string }) => entry.provider === '__proto__');
    expect(prototypeProvider.totalTokens).toBe(1000);
    const constructorProvider = range.providerShares.find((entry: { provider: string }) => entry.provider === 'constructor');
    expect(constructorProvider.totalTokens).toBe(500);
  });

  it('deduplicates a session that reappears in a later batch of a closed day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T12:00:00'));
    const outputDir = path.join(tmpDir, 'logs', 'output');
    const file = await writeJsonl(outputDir, 'claude-code-2026-07-30.jsonl', [
      record({ 'event.name': 'llm.request', 'gen_ai.usage.total_tokens': '0' }),
    ]);
    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();

    vi.setSystemTime(new Date('2026-07-31T09:00:00'));
    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();
    await fs.appendFile(file, JSON.stringify(record({ 'event.name': 'llm.request', 'gen_ai.usage.total_tokens': '0' })) + '\n');
    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();

    const range = (await readSummary(tmpDir)).ranges.sevenDays;
    const agent = range.agentShares.find((entry: { agentType: string }) => entry.agentType === 'claude-code');
    expect(agent.sessions).toBe(1);
    expect(agent.events).toBe(2);
  });

  it('backfills a legacy day on upgrade and flags a day it cannot repair', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T10:00:00'));
    const outputDir = path.join(tmpDir, 'logs', 'output');

    // 07-30: the whole day is still on disk, so the upgrade can rebuild it.
    const complete = await writeJsonl(outputDir, 'claude-code-2026-07-30.jsonl', [
      record({ 'gen_ai.session.id': 'a', 'gen_ai.usage.total_tokens': '600' }),
      record({ 'gen_ai.session.id': 'b', 'gen_ai.usage.total_tokens': '400' }),
    ]);
    // 08-01: only part of the day survived, so its totals must be preserved.
    const partial = await writeJsonl(outputDir, 'codex-2026-08-01.jsonl', [
      record({ 'gen_ai.agent.type': 'codex', 'gen_ai.usage.total_tokens': '300' }),
    ]);

    const completeStat = await fs.stat(complete);
    const partialStat = await fs.stat(partial);
    await seedLegacyState(tmpDir, {
      '2026-07-30': {
        tokens: 1000, inputTokens: 200, outputTokens: 200, cacheReadTokens: 0,
        cacheCreationTokens: 0, sessions: 2, requests: 2, toolCalls: 0, events: 2,
      },
      '2026-08-01': {
        tokens: 800, inputTokens: 160, outputTokens: 160, cacheReadTokens: 0,
        cacheCreationTokens: 0, sessions: 2, requests: 2, toolCalls: 0, events: 2,
      },
    }, {
      'claude-code-2026-07-30.jsonl': { offset: completeStat.size, size: completeStat.size, ino: completeStat.ino },
      'codex-2026-08-01.jsonl': { offset: partialStat.size, size: partialStat.size, ino: partialStat.ino },
    });

    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();

    const range = (await readSummary(tmpDir)).ranges.sevenDays;
    expect(range.totalTokens).toBe(1800);
    const model = range.modelShares.find((entry: { model: string }) => entry.model === 'claude-opus-4-6');
    expect(model.totalTokens).toBe(1000);
    // The 08-01 totals still come from the digest; its breakdown is reported as
    // incomplete instead of silently shrinking the shares.
    expect(range.incompleteBreakdownDays).toEqual(['2026-08-01']);
  });

  it('does not drop totals that belong to a segment retention already removed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T10:00:00'));
    const outputDir = path.join(tmpDir, 'logs', 'output');
    const cache = path.join(tmpDir, 'cache');
    await fs.mkdir(cache, { recursive: true });
    await fs.writeFile(path.join(cache, 'metrics-daily-digest.json'), JSON.stringify({
      version: 1,
      days: {
        '2026-07-30': {
          tokens: 1000, inputTokens: 200, outputTokens: 200, cacheReadTokens: 0,
          cacheCreationTokens: 0, sessions: 1, requests: 2, toolCalls: 0, events: 2,
          modelTokens: { 'claude-opus-4-6': { total: 1000, input: 200, cacheRead: 0 } },
          agentStats: { 'claude-code': { sessions: 1, events: 2, tokens: 1000, sessionIds: ['s1'] } },
          providerTokens: { anthropic: 1000 },
          repoStats: {},
          segments: ['claude-code-2026-07-30.jsonl'],
        },
      },
    }));
    // A second segment for that closed day shows up after the first was retired.
    await writeJsonl(outputDir, 'codex-2026-07-30.jsonl', [
      record({ 'gen_ai.agent.type': 'codex', 'gen_ai.session.id': 's2', 'gen_ai.usage.total_tokens': '300' }),
    ]);

    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();

    const range = (await readSummary(tmpDir)).ranges.sevenDays;
    expect(range.totalTokens).toBe(1300);
    const claude = range.agentShares.find((entry: { agentType: string }) => entry.agentType === 'claude-code');
    expect(claude.tokens).toBe(1000);
    const codex = range.agentShares.find((entry: { agentType: string }) => entry.agentType === 'codex');
    expect(codex.tokens).toBe(300);
  });

  it('reports a legacy day whose segment is already gone instead of returning silent partial shares', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T10:00:00'));
    const outputDir = path.join(tmpDir, 'logs', 'output');
    await fs.mkdir(outputDir, { recursive: true });
    await seedLegacyState(tmpDir, {
      '2026-08-01': {
        tokens: 900, inputTokens: 180, outputTokens: 180, cacheReadTokens: 0,
        cacheCreationTokens: 0, sessions: 1, requests: 3, toolCalls: 0, events: 3,
      },
    }, {});

    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();

    const range = (await readSummary(tmpDir)).ranges.sevenDays;
    expect(range.totalTokens).toBe(900);
    expect(range.modelShares).toEqual([]);
    expect(range.incompleteBreakdownDays).toEqual(['2026-08-01']);
  });
});
