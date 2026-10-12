import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  buildInterceptorConfig,
  ensureMaskCoversInterceptor,
  isRuleEnabled,
  resolveEnabledInterceptorTypes,
} from '../../../src/interceptor/config.js';
import { SUPPORTED_INTERCEPTOR_TYPES } from '../../../src/types/index.js';

describe('interceptor config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to none when interceptor config is missing', () => {
    expect(buildInterceptorConfig(undefined)).toEqual({ mode: 'none', types: [] });
    expect(buildInterceptorConfig(null)).toEqual({ mode: 'none', types: [] });
    expect(buildInterceptorConfig([])).toEqual({ mode: 'none', types: [] });
  });

  it('defaults to none when interceptor.mode is missing', () => {
    expect(buildInterceptorConfig({ types: ['apiKey'] })).toEqual({ mode: 'none', types: [] });
  });

  it('loads all mode and ignores types', () => {
    expect(buildInterceptorConfig({
      mode: 'all',
      types: ['apiKey'],
    })).toEqual({ mode: 'all', types: [] });
  });

  it('loads custom mode with interceptor types only', () => {
    expect(buildInterceptorConfig({
      mode: 'custom',
      types: [
        'apiKey',
        'cloudAccessKey',
        'idCard',
        'phone',
        'email',
        'ipAddress',
        'bankCard',
        'databaseUrl',
        'privateKey',
      ],
    })).toEqual({
      mode: 'custom',
      types: ['apiKey', 'cloudAccessKey', 'databaseUrl', 'privateKey'],
    });
  });

  it('treats invalid mode as none', () => {
    expect(buildInterceptorConfig({
      mode: 'audit',
      types: ['apiKey'],
    })).toEqual({ mode: 'none', types: [] });
  });

  it('custom mode with empty or omitted types enables no interceptor types', () => {
    expect(buildInterceptorConfig({ mode: 'custom' })).toEqual({ mode: 'custom', types: [] });
    expect(buildInterceptorConfig({ mode: 'custom', types: [] })).toEqual({ mode: 'custom', types: [] });
  });

  it('uses interceptor mode env over config value', () => {
    vi.stubEnv('LOONGSUITE_PILOT_INTERCEPTOR_MODE', 'all');
    expect(buildInterceptorConfig({
      mode: 'none',
      types: ['apiKey'],
    })).toEqual({ mode: 'all', types: [] });
  });

  it('uses interceptor types env for custom mode and filters unsupported values', () => {
    vi.stubEnv('LOONGSUITE_PILOT_INTERCEPTOR_MODE', 'custom');
    vi.stubEnv(
      'LOONGSUITE_PILOT_INTERCEPTOR_TYPES',
      'cloudAccessKey,idCard,databaseUrl,phone,privateKey',
    );
    expect(buildInterceptorConfig({
      mode: 'custom',
      types: ['apiKey'],
    })).toEqual({
      mode: 'custom',
      types: ['cloudAccessKey', 'databaseUrl', 'privateKey'],
    });
  });

  it('resolves enabled types from mode', () => {
    expect([...resolveEnabledInterceptorTypes({ mode: 'none', types: ['apiKey'] })]).toEqual([]);
    expect([...resolveEnabledInterceptorTypes({ mode: 'all', types: [] })]).toEqual([
      ...SUPPORTED_INTERCEPTOR_TYPES,
    ]);
    expect([...resolveEnabledInterceptorTypes({
      mode: 'custom',
      types: ['apiKey'],
    })]).toEqual(['apiKey']);
  });

  it('treats empty interceptor env values as unset', () => {
    vi.stubEnv('LOONGSUITE_PILOT_INTERCEPTOR_MODE', '  ');
    expect(buildInterceptorConfig({ mode: 'all', types: [] })).toEqual({ mode: 'all', types: [] });

    vi.stubEnv('LOONGSUITE_PILOT_INTERCEPTOR_MODE', 'custom');
    vi.stubEnv('LOONGSUITE_PILOT_INTERCEPTOR_TYPES', '');
    expect(buildInterceptorConfig({ mode: 'custom', types: ['apiKey'] })).toEqual({
      mode: 'custom',
      types: ['apiKey'],
    });
  });

  it('unions enabled interceptor types into a mask plan that is not already all', () => {
    expect(ensureMaskCoversInterceptor(
      { mode: 'none', types: [], replacementMode: 'placeholder' },
      { mode: 'all', types: [] },
    )).toEqual({
      mode: 'custom',
      types: [...SUPPORTED_INTERCEPTOR_TYPES],
      replacementMode: 'placeholder',
    });
    expect(ensureMaskCoversInterceptor(
      { mode: 'custom', types: ['email'], replacementMode: 'placeholder' },
      { mode: 'custom', types: ['apiKey'] },
    )).toEqual({
      mode: 'custom',
      types: ['email', 'apiKey'],
      replacementMode: 'placeholder',
    });
    expect(ensureMaskCoversInterceptor(
      { mode: 'all', types: [] },
      { mode: 'all', types: [] },
    )).toEqual({ mode: 'all', types: [] });
    expect(ensureMaskCoversInterceptor(
      { mode: 'none', types: [] },
      { mode: 'none', types: [] },
    )).toEqual({ mode: 'none', types: [] });
  });

  it('treats missing and disabled types as bypass', () => {
    expect(isRuleEnabled({ mode: 'none', types: [] }, 'apiKey')).toBe(false);
    expect(isRuleEnabled({ mode: 'custom', types: [] }, 'apiKey')).toBe(false);
    expect(isRuleEnabled({ mode: 'custom', types: ['privateKey'] }, 'apiKey')).toBe(false);
    expect(isRuleEnabled({ mode: 'custom', types: ['apiKey'] }, 'apiKey')).toBe(true);
    expect(isRuleEnabled({ mode: 'all', types: [] }, 'apiKey')).toBe(true);
    expect(isRuleEnabled({ mode: 'all', types: [] }, 'idCard')).toBe(false);
  });
});
