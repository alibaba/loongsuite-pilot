import { afterEach, describe, expect, it, vi } from 'vitest';
import { HookReplayBudget, HOOK_HISTORY_RATE_ENV, HOOK_RECORD_LIMIT_ENV } from '../../../src/inputs/base/hook-replay-budget.js';

afterEach(() => vi.unstubAllEnvs());
describe('Hook history replay budget', () => {
  it('bounds the burst and refill independently of repeated polls', () => {
    let now = 0;
    const budget = new HookReplayBudget({ bytesPerMinute: 4 * 1024 * 1024, now: () => now });
    expect(budget.available()).toBe(1024 * 1024);
    budget.charge(1024 * 1024);
    expect(budget.available()).toBe(0);
    expect(budget.available()).toBe(0);
    now = 7500;
    expect(budget.available()).toBe(512 * 1024);
    now = 600000;
    expect(budget.available()).toBe(1024 * 1024);
  });
  it('charges a record crossing the burst as debt instead of raising the sustained rate', () => {
    let now = 0;
    const budget = new HookReplayBudget({ bytesPerMinute: 4 * 1024 * 1024, now: () => now });
    budget.charge(8 * 1024 * 1024);
    now = 60000;
    expect(budget.available()).toBe(0);
    now = 120000;
    expect(budget.available()).toBe(1024 * 1024);
  });
  it.each(['-1', '1e8', '1.5', 'NaN', '9007199254740992'])('rejects unsafe rate %s', rate => {
    vi.stubEnv(HOOK_HISTORY_RATE_ENV, rate);
    expect(new HookReplayBudget().available()).toBeGreaterThan(0);
  });
  it('supports pausing background replay without a busy retry', () => {
    vi.stubEnv(HOOK_HISTORY_RATE_ENV, '0');
    const budget = new HookReplayBudget();
    expect(budget.available()).toBe(0);
  });
  it('does not charge time spent waiting for I/O as processing CPU', () => {
    let wall = 0, cpu = 0;
    const budget = new HookReplayBudget({ now: () => wall, cpuNow: () => cpu });
    const work = budget.work(); work.records = 1;
    wall += 60000;
    expect(work.canProcess()).toBe(true);
    cpu += 51;
    expect(work.canProcess()).toBe(false);
  });
  it('allows an explicit bounded record limit for recovering a preserved oversized source', () => {
    vi.stubEnv(HOOK_RECORD_LIMIT_ENV, String(64 * 1024 * 1024));
    expect(new HookReplayBudget().work().maxRecordBytes).toBe(64 * 1024 * 1024);
    vi.stubEnv(HOOK_RECORD_LIMIT_ENV, '10000000000');
    expect(new HookReplayBudget().work().maxRecordBytes).toBe(32 * 1024 * 1024);
  });
});
