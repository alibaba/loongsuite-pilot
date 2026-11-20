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
  days: Record<string, Record<string, unknown>>,
  offsets: Record<string, unknown>,
  synchronized = true,
): Promise<void> {
  const cache = path.join(dir, 'cache');
  await fs.mkdir(cache, { recursive: true });
  const digestPath = path.join(cache, 'metrics-daily-digest.json');
  const scanPath = path.join(cache, 'metrics-scan-state.json');
  await fs.writeFile(digestPath, JSON.stringify({ version: 1, days }));
  await fs.writeFile(scanPath, JSON.stringify({ files: offsets }));
  // Give fixtures a definite order even on filesystems with coarse mtimes.
  const time = Math.ceil((await fs.stat(scanPath)).mtimeMs / 1000);
  await fs.utimes(digestPath, time, time);
  await fs.utimes(scanPath, time, synchronized ? time + 1 : time - 1);
}

function legacyDay(tokens: number, events: number): Record<string, number> {
  return {
    tokens, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheCreationTokens: 0, sessions: 1, requests: 0, toolCalls: 0, events,
  };
}

/** Simulate retention: move the segment out of the scanned directory. */
async function retire(dir: string, name: string): Promise<void> {
  const retired = path.join(dir, '..', 'retired');
  await fs.mkdir(retired, { recursive: true });
  await fs.rename(path.join(dir, name), path.join(retired, name));
}

async function seedPartialLegacyDay(dir: string, synchronized: boolean) {
  const outputDir = path.join(dir, 'logs', 'output');
  const archivedName = 'claude-code.part-1-2026-08-01.jsonl';
  const activeName = 'claude-code-2026-08-01.jsonl';
  const archived = await writeJsonl(outputDir, archivedName, [
    record({ 'gen_ai.request.model': 'archived-model', 'gen_ai.usage.total_tokens': '1000' }),
  ]);
  const active = await writeJsonl(outputDir, activeName, [
    record({ 'gen_ai.request.model': 'active-model', 'gen_ai.usage.total_tokens': '300' }),
  ]);
  const archivedStat = await fs.stat(archived);
  const activeStat = await fs.stat(active);
  if (!synchronized) {
    await fs.appendFile(active, JSON.stringify(record({ 'gen_ai.usage.total_tokens': '50' })) + '\n');
  }
  await seedLegacyState(dir, {
    '2026-08-01': synchronized ? legacyDay(1300, 2) : legacyDay(1350, 3),
  }, {
    [archivedName]: { offset: archivedStat.size, size: archivedStat.size, ino: archivedStat.ino },
    [activeName]: { offset: activeStat.size, size: activeStat.size, ino: activeStat.ino },
  }, synchronized);
  await retire(outputDir, archivedName);
  return { active, archived, retired: path.join(dir, 'logs', 'retired', archivedName) };
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
    vi.setSystemTime(new Date('2026-07-30T12:00:00'));
    const outputDir = path.join(tmpDir, 'logs', 'output');
    await writeJsonl(outputDir, 'claude-code-2026-07-30.jsonl', [
      record({ 'gen_ai.session.id': 's1', 'gen_ai.usage.total_tokens': '1000' }),
    ]);
    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();
    vi.setSystemTime(new Date('2026-07-31T09:00:00'));
    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();

    // Retention removes the first segment, then a second segment for that
    // closed day shows up.
    await retire(outputDir, 'claude-code-2026-07-30.jsonl');
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

  it('adds a new segment for a closed day while the earlier segment is still on disk', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T12:00:00'));
    const outputDir = path.join(tmpDir, 'logs', 'output');
    await writeJsonl(outputDir, 'claude-code-2026-07-30.jsonl', [record({ 'gen_ai.usage.total_tokens': '1000' })]);
    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();
    vi.setSystemTime(new Date('2026-07-31T09:00:00'));
    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();

    await writeJsonl(outputDir, 'codex-2026-07-30.jsonl', [
      record({ 'gen_ai.agent.type': 'codex', 'gen_ai.usage.total_tokens': '300' }),
    ]);
    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();

    expect((await readSummary(tmpDir)).ranges.sevenDays.totalTokens).toBe(1300);
  });

  it('resumes a rotated closed-day segment by inode and adds the new active file', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T12:00:00'));
    const outputDir = path.join(tmpDir, 'logs', 'output');
    await writeJsonl(outputDir, 'claude-code-2026-07-30.jsonl', [record({ 'gen_ai.usage.total_tokens': '1000' })]);
    const codex = await writeJsonl(outputDir, 'codex-2026-07-30.jsonl', [
      record({ 'gen_ai.agent.type': 'codex', 'gen_ai.usage.total_tokens': '300' }),
    ]);
    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();
    vi.setSystemTime(new Date('2026-07-31T09:00:00'));
    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();

    await fs.rename(codex, path.join(outputDir, 'codex.part-1-2026-07-30.jsonl'));
    await writeJsonl(outputDir, 'codex-2026-07-30.jsonl', [
      record({ 'gen_ai.agent.type': 'codex', 'gen_ai.usage.total_tokens': '50' }),
    ]);
    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();

    expect((await readSummary(tmpDir)).ranges.sevenDays.totalTokens).toBe(1350);
  });

  it('does not double count a closed day when the scan state is lost', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T12:00:00'));
    const outputDir = path.join(tmpDir, 'logs', 'output');
    await writeJsonl(outputDir, 'claude-code-2026-07-30.jsonl', [record({ 'gen_ai.usage.total_tokens': '1000' })]);
    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();
    vi.setSystemTime(new Date('2026-07-31T09:00:00'));
    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();

    await fs.writeFile(path.join(tmpDir, 'cache', 'metrics-scan-state.json'), JSON.stringify({ files: {} }));
    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();

    expect((await readSummary(tmpDir)).ranges.sevenDays.totalTokens).toBe(1000);
  });

  it('rebuilds a legacy day once from its segments when the scan state is gone', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T10:00:00'));
    const outputDir = path.join(tmpDir, 'logs', 'output');
    await writeJsonl(outputDir, 'claude-code-2026-08-01.jsonl', [record({ 'gen_ai.usage.total_tokens': '1000' })]);
    await seedLegacyState(tmpDir, { '2026-08-01': legacyDay(1000, 1) }, {});

    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();
    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();

    const range = (await readSummary(tmpDir)).ranges.thirtyDays;
    expect(range.totalTokens).toBe(1000);
    expect(range.modelShares).toEqual([expect.objectContaining({ model: 'claude-opus-4-6', totalTokens: 1000 })]);
    expect(range.incompleteBreakdownDays).toBeUndefined();
  });

  it('keeps records appended to a legacy day before the first refresh after an upgrade', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T10:00:00'));
    const outputDir = path.join(tmpDir, 'logs', 'output');
    const file = await writeJsonl(outputDir, 'claude-code-2026-08-01.jsonl', [record({ 'gen_ai.usage.total_tokens': '1000' })]);
    const stat = await fs.stat(file);
    await seedLegacyState(tmpDir, { '2026-08-01': legacyDay(1000, 1) }, {
      'claude-code-2026-08-01.jsonl': { offset: stat.size, size: stat.size, ino: stat.ino },
    });
    await fs.appendFile(file, JSON.stringify(record({ 'gen_ai.usage.total_tokens': '500' })) + '\n');

    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();

    const range = (await readSummary(tmpDir)).ranges.sevenDays;
    expect(range.totalTokens).toBe(1500);
    expect(range.modelShares[0].totalTokens).toBe(1500);
    expect(range.incompleteBreakdownDays).toBeUndefined();
  });

  it('recognizes a restored segment saved under a legacy retired identity', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T10:00:00'));
    const outputDir = path.join(tmpDir, 'logs', 'output');
    const name = 'claude-code-2026-08-01.jsonl';
    const restored = await writeJsonl(outputDir, 'claude-code.part-1-2026-08-01.jsonl', [
      record({ 'gen_ai.request.model': 'first-model', 'gen_ai.usage.total_tokens': '1000' }),
    ]);
    const active = await writeJsonl(outputDir, name, [
      record({ 'gen_ai.request.model': 'second-model', 'gen_ai.usage.total_tokens': '300' }),
    ]);
    const { dev, ino, birthtimeMs, size } = await fs.stat(restored);
    const activeStat = await fs.stat(active);
    await seedLegacyState(tmpDir, { '2026-08-01': legacyDay(1300, 2) }, {
      [`retired:${dev}:${ino}:${birthtimeMs}`]: { offset: size, size, ino },
      [name]: { offset: activeStat.size, size: activeStat.size, ino: activeStat.ino },
    });

    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();

    const range = (await readSummary(tmpDir)).ranges.sevenDays;
    expect(range.totalTokens).toBe(1300);
    expect(range.modelShares).toEqual([
      expect.objectContaining({ model: 'first-model', totalTokens: 1000 }),
      expect.objectContaining({ model: 'second-model', totalTokens: 300 }),
    ]);
    expect(range.incompleteBreakdownDays).toBeUndefined();
  });

  it.each([0, 200])('reconciles a legacy digest written ahead of its offset with %i new tokens', async newTokens => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T10:00:00'));
    const outputDir = path.join(tmpDir, 'logs', 'output');
    const name = 'claude-code-2026-08-01.jsonl';
    const file = await writeJsonl(outputDir, name, [record({ 'gen_ai.usage.total_tokens': '1000' })]);
    const stat = await fs.stat(file);
    await fs.appendFile(file, JSON.stringify(record({ 'gen_ai.usage.total_tokens': '300' })) + '\n');
    await seedLegacyState(tmpDir, { '2026-08-01': legacyDay(1300, 2) }, {
      [name]: { offset: stat.size, size: stat.size, ino: stat.ino },
    });
    if (newTokens > 0) {
      await fs.appendFile(file, JSON.stringify(record({ 'gen_ai.usage.total_tokens': String(newTokens) })) + '\n');
    }

    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();
    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();

    const range = (await readSummary(tmpDir)).ranges.thirtyDays;
    expect(range.totalTokens).toBe(1300 + newTokens);
    expect(range.modelShares[0].totalTokens).toBe(1300 + newTokens);
    expect(range.incompleteBreakdownDays).toBeUndefined();
  });

  it('rebuilds a legacy day with a corrupt dated scan offset', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T10:00:00'));
    const outputDir = path.join(tmpDir, 'logs', 'output');
    const name = 'claude-code-2026-08-01.jsonl';
    await writeJsonl(outputDir, name, [record({ 'gen_ai.usage.total_tokens': '1000' })]);
    await seedLegacyState(tmpDir, { '2026-08-01': legacyDay(1000, 1) }, { [name]: null });

    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();

    const range = (await readSummary(tmpDir)).ranges.sevenDays;
    expect(range.totalTokens).toBe(1000);
    expect(range.modelShares[0].totalTokens).toBe(1000);
    expect(range.incompleteBreakdownDays).toBeUndefined();
  });

  it('counts new bytes from a coherent legacy checkpoint and resumes a restored archive after sidecar loss', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T10:00:00'));
    const { active, archived, retired } = await seedPartialLegacyDay(tmpDir, true);
    await fs.appendFile(active, JSON.stringify(record({ 'gen_ai.request.model': 'new-model', 'gen_ai.usage.total_tokens': '50' })) + '\n');

    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();
    const partial = (await readSummary(tmpDir)).ranges.sevenDays;
    expect(partial.totalTokens).toBe(1350);
    expect(partial.modelShares[0]).toMatchObject({ model: 'new-model', totalTokens: 50 });
    expect(partial.incompleteBreakdownDays).toEqual(['2026-08-01']);

    await fs.unlink(path.join(tmpDir, 'cache', 'metrics-scan-state.json'));
    await fs.rename(retired, archived);
    await fs.appendFile(archived, JSON.stringify(record({ 'gen_ai.request.model': 'restored-model', 'gen_ai.usage.total_tokens': '10' })) + '\n');
    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();
    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();

    const range = (await readSummary(tmpDir)).ranges.sevenDays;
    expect(range.totalTokens).toBe(1360);
    expect(range.modelShares).toContainEqual(expect.objectContaining({ model: 'restored-model', totalTokens: 10 }));
  });

  it('preserves unresolved legacy offsets until the missing archive makes a safe rebuild possible', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T10:00:00'));
    const { active, archived, retired } = await seedPartialLegacyDay(tmpDir, false);
    await fs.appendFile(active, JSON.stringify(record({ 'gen_ai.request.model': 'new-model', 'gen_ai.usage.total_tokens': '10' })) + '\n');

    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();
    await fs.unlink(path.join(tmpDir, 'cache', 'metrics-scan-state.json'));
    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();
    const unresolved = (await readSummary(tmpDir)).ranges.sevenDays;
    expect(unresolved.totalTokens).toBe(1350);
    expect(unresolved.incompleteBreakdownDays).toEqual(['2026-08-01']);

    await fs.rename(retired, archived);
    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();
    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();

    const resolved = (await readSummary(tmpDir)).ranges.sevenDays;
    expect(resolved.totalTokens).toBe(1360);
    expect(resolved.modelShares).toContainEqual(expect.objectContaining({ model: 'new-model', totalTokens: 10 }));
    expect(resolved.incompleteBreakdownDays).toBeUndefined();
  });

  it('keeps legacy totals of a retired segment and adds a segment the old scan state never saw', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T10:00:00'));
    const outputDir = path.join(tmpDir, 'logs', 'output');
    await fs.mkdir(outputDir, { recursive: true });
    // The legacy 800 came from claude-code-2026-08-01.jsonl, which retention removed.
    await seedLegacyState(tmpDir, { '2026-08-01': legacyDay(800, 2) }, {
      'claude-code-2026-08-01.jsonl': { offset: 400, size: 400, ino: 1 },
    });
    await writeJsonl(outputDir, 'codex-2026-08-01.jsonl', [
      record({ 'gen_ai.agent.type': 'codex', 'gen_ai.usage.total_tokens': '300' }),
    ]);

    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();
    // Losing the scan state afterwards must not change the day either.
    await fs.writeFile(path.join(tmpDir, 'cache', 'metrics-scan-state.json'), JSON.stringify({ files: {} }));
    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();

    const range = (await readSummary(tmpDir)).ranges.sevenDays;
    expect(range.totalTokens).toBe(1100);
    expect(range.incompleteBreakdownDays).toEqual(['2026-08-01']);
  });

  it('drops per-file session identities once a day leaves the detail window but keeps counting appends', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T12:00:00'));
    const outputDir = path.join(tmpDir, 'logs', 'output');
    const file = await writeJsonl(outputDir, 'claude-code-2026-07-30.jsonl', [
      record({ 'gen_ai.session.id': 's1', 'gen_ai.usage.total_tokens': '1000' }),
    ]);
    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();
    vi.setSystemTime(new Date('2026-08-10T09:00:00'));
    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();

    const digest = JSON.parse(await fs.readFile(path.join(tmpDir, 'cache', 'metrics-daily-digest.json'), 'utf8'));
    const day = digest.days['2026-07-30'];
    expect(day.tokens).toBe(1000);
    expect(day.files).toHaveLength(1);
    expect(day.files[0].stats).toBeUndefined();
    expect(JSON.stringify(day)).not.toContain('"s1"');

    await fs.appendFile(file, JSON.stringify(record({ 'gen_ai.session.id': 's2', 'gen_ai.usage.total_tokens': '200' })) + '\n');
    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();
    const range = (await readSummary(tmpDir)).ranges.thirtyDays;
    expect(range.totalTokens).toBe(1200);
    expect(range.modelShares[0].totalTokens).toBe(1200);
  });

  it('resumes a compacted segment after its temporary absence without recounting it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T12:00:00'));
    const outputDir = path.join(tmpDir, 'logs', 'output');
    const name = 'claude-code-2026-07-30.jsonl';
    const file = await writeJsonl(outputDir, name, [record({ 'gen_ai.usage.total_tokens': '1000' })]);
    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();

    vi.setSystemTime(new Date('2026-08-10T09:00:00'));
    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();
    await retire(outputDir, name);
    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();
    expect((await readSummary(tmpDir)).ranges.thirtyDays.totalTokens).toBe(1000);

    await fs.rename(path.join(outputDir, '..', 'retired', name), file);
    await fs.appendFile(file, JSON.stringify(record({ 'gen_ai.usage.total_tokens': '200' })) + '\n');
    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();

    const range = (await readSummary(tmpDir)).ranges.thirtyDays;
    expect(range.totalTokens).toBe(1200);
    expect(range.modelShares[0].totalTokens).toBe(1200);
  });

  it('treats a digest day with corrupt tracking state as a legacy day instead of failing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T10:00:00'));
    const outputDir = path.join(tmpDir, 'logs', 'output');
    await writeJsonl(outputDir, 'claude-code-2026-08-01.jsonl', [record({ 'gen_ai.usage.total_tokens': '1000' })]);
    await seedLegacyState(tmpDir, {
      '2026-08-01': { ...legacyDay(1000, 1), files: [{ fileName: 'x', stats: { broken: true } }] },
    } as never, {});

    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();

    const range = (await readSummary(tmpDir)).ranges.sevenDays;
    expect(range.totalTokens).toBe(1000);
    expect(range.modelShares[0].totalTokens).toBe(1000);
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

  it('reports missing agent and repository breakdowns for a legacy tool-only day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T10:00:00'));
    await seedLegacyState(tmpDir, {
      '2026-08-01': { ...legacyDay(0, 1), toolCalls: 1 },
    }, {});

    await new MetricsSummaryWriter(tmpDir, makeConfig()).refresh();

    const range = (await readSummary(tmpDir)).ranges.sevenDays;
    expect(range.totalTokens).toBe(0);
    expect(range.totalToolCalls).toBe(1);
    expect(range.incompleteBreakdownDays).toEqual(['2026-08-01']);
  });
});
