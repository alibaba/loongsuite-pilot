import { beforeEach, describe, expect, it, vi } from 'vitest';

const readFileSyncMock = vi.hoisted(() => vi.fn());
const loggerErrorMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs', () => ({
  readFileSync: readFileSyncMock,
}));

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: loggerErrorMock,
  }),
}));

describe('mask rule loader fallback', () => {
  beforeEach(() => {
    vi.resetModules();
    readFileSyncMock.mockReset();
    loggerErrorMock.mockClear();
  });

  it('disables manifest rules but keeps built-in PII detectors when the manifest cannot be read', async () => {
    readFileSyncMock.mockImplementationOnce(() => {
      throw new Error('missing sensitive rules');
    });
    const { loadEnabledRules, loadMaskPlan, loadSensitiveRules } = await import(
      '../../../src/mask/rule-loader.js'
    );

    expect(loadSensitiveRules()).toEqual([]);
    expect(loadEnabledRules({ mode: 'all', types: [] })).toEqual([]);
    expect([...loadMaskPlan({ mode: 'all', types: [] }).piiTypes]).toEqual([
      'idCard',
      'phone',
      'email',
      'ipAddress',
      'bankCard',
    ]);
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'failed to load sensitive rule manifest, manifest rules disabled',
      expect.objectContaining({ error: expect.stringContaining('missing sensitive rules') }),
    );
  });

  it('disables manifest rules when the manifest JSON is invalid', async () => {
    readFileSyncMock.mockReturnValueOnce('{ invalid json');
    const { loadEnabledRules } = await import('../../../src/mask/rule-loader.js');

    expect(loadEnabledRules({ mode: 'all', types: [] })).toEqual([]);
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'failed to load sensitive rule manifest, manifest rules disabled',
      expect.objectContaining({ error: expect.any(String) }),
    );
  });
});
