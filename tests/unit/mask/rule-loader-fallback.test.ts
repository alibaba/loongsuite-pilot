import { beforeEach, describe, expect, it, vi } from 'vitest';

const loggerErrorMock = vi.hoisted(() => vi.fn());

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
    loggerErrorMock.mockClear();
  });

  it('disables manifest rules but keeps built-in PII detectors when the manifest cannot be compiled', async () => {
    const { loadMaskPlan, loadSensitiveRulesFromManifest } = await import(
      '../../../src/mask/rule-loader.js'
    );

    expect(loadSensitiveRulesFromManifest({ version: 2, rules: [] })).toEqual([]);
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'failed to load sensitive rule manifest, manifest rules disabled',
      expect.objectContaining({ error: expect.any(String) }),
    );
    expect([...loadMaskPlan({ mode: 'all', types: [] }).piiTypes]).toEqual([
      'idCard',
      'phone',
      'email',
      'ipAddress',
      'bankCard',
    ]);
  });

  it('disables manifest rules when a rule definition fails to compile', async () => {
    const { loadSensitiveRulesFromManifest } = await import('../../../src/mask/rule-loader.js');

    expect(loadSensitiveRulesFromManifest({
      version: 1,
      rules: [
        {
          id: 'broken.regex',
          type: 'apiKey',
          kind: 'regex',
          replacement: '[APIKEY_MASKED]',
          prefilter: ['sk-'],
          pattern: '[',
          flags: 'g',
        },
      ],
    })).toEqual([]);
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'failed to load sensitive rule manifest, manifest rules disabled',
      expect.objectContaining({ error: expect.any(String) }),
    );
  });
});
