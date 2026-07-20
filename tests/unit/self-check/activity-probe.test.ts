import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

const mockStat = vi.fn();
vi.mock('node:fs/promises', () => ({ stat: (...args: unknown[]) => mockStat(...args) }));

const mockResolveHome = vi.fn((p: string) => p.replace(/^~/, '/home/test'));
vi.mock('../../../src/utils/fs-utils.js', () => ({
  resolveHome: (p: string) => mockResolveHome(p),
}));

import { probeActivity } from '../../../src/self-check/activity-probe.js';

describe('probeActivity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns active when file was recently modified', async () => {
    mockStat.mockResolvedValueOnce({ mtimeMs: Date.now() - 60_000 });
    const result = await probeActivity('~/.claude/history.jsonl', 300_000);
    expect(result.active).toBe(true);
    expect(result.mtimeMs).toBeGreaterThan(0);
    expect(mockResolveHome).toHaveBeenCalledWith('~/.claude/history.jsonl');
  });

  it('returns not active when file is older than threshold', async () => {
    mockStat.mockResolvedValueOnce({ mtimeMs: Date.now() - 600_000 });
    const result = await probeActivity('~/.claude/history.jsonl', 300_000);
    expect(result.active).toBe(false);
    expect(result.mtimeMs).toBeGreaterThan(0);
  });

  it('returns not active when file does not exist', async () => {
    mockStat.mockRejectedValueOnce(new Error('ENOENT'));
    const result = await probeActivity('~/.nonexistent/file', 300_000);
    expect(result.active).toBe(false);
    expect(result.mtimeMs).toBe(0);
  });

  it('does not expand ~ for absolute paths', async () => {
    mockStat.mockResolvedValueOnce({ mtimeMs: Date.now() - 1_000 });
    await probeActivity('/absolute/path/file.txt', 300_000);
    expect(mockResolveHome).not.toHaveBeenCalled();
  });
});
