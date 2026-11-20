import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  buildInterceptorConfig,
  ensureMaskCoversInterceptor,
  INTERCEPTOR_MASK_TYPES,
  shouldDeployInterceptorHooks,
} from '../../../src/interceptor/config.js';
import type { MaskConfig } from '../../../src/types/index.js';

describe('interceptor config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to none when interceptor config is missing', () => {
    expect(buildInterceptorConfig(undefined)).toEqual({ mode: 'none' });
    expect(buildInterceptorConfig(null)).toEqual({ mode: 'none' });
    expect(buildInterceptorConfig([])).toEqual({ mode: 'none' });
  });

  it('defaults to none when interceptor.mode is missing', () => {
    expect(buildInterceptorConfig({ types: ['apiKey'] })).toEqual({ mode: 'none' });
  });

  it('loads all mode and ignores types', () => {
    expect(buildInterceptorConfig({
      mode: 'all',
      types: ['apiKey'],
    })).toEqual({ mode: 'all' });
  });

  it('treats custom and other unknown modes as none', () => {
    expect(buildInterceptorConfig({ mode: 'custom', types: ['apiKey'] })).toEqual({ mode: 'none' });
    expect(buildInterceptorConfig({
      mode: 'audit',
      types: ['apiKey'],
    })).toEqual({ mode: 'none' });
  });

  it('uses interceptor mode env over config value', () => {
    vi.stubEnv('LOONGSUITE_PILOT_INTERCEPTOR_MODE', 'all');
    expect(buildInterceptorConfig({
      mode: 'none',
      types: ['apiKey'],
    })).toEqual({ mode: 'all' });
  });

  it('treats a custom mode env as none', () => {
    vi.stubEnv('LOONGSUITE_PILOT_INTERCEPTOR_MODE', 'custom');
    expect(buildInterceptorConfig({ mode: 'all' })).toEqual({ mode: 'none' });
  });

  it('treats empty interceptor env values as unset', () => {
    vi.stubEnv('LOONGSUITE_PILOT_INTERCEPTOR_MODE', '  ');
    expect(buildInterceptorConfig({ mode: 'all' })).toEqual({ mode: 'all' });
  });

  it('deploys interceptor hooks only for all mode', () => {
    expect(shouldDeployInterceptorHooks({ mode: 'all' })).toBe(true);
    expect(shouldDeployInterceptorHooks({ mode: 'none' })).toBe(false);
    expect(shouldDeployInterceptorHooks(buildInterceptorConfig({ mode: 'custom', types: ['apiKey'] }))).toBe(false);
  });

  describe('credential masking for interception', () => {
    it.each<MaskConfig>([
      { mode: 'none', types: [], replacementMode: 'preview' },
      { mode: 'all', types: [], replacementMode: 'preview' },
      { mode: 'custom', types: ['email', 'apiKey'], replacementMode: 'preview' },
    ])('preserves mask $mode when interception is disabled', mask => {
      expect(ensureMaskCoversInterceptor(mask, { mode: 'none' })).toBe(mask);
    });

    it('promotes mask none to the credential mask union and preserves replacement mode', () => {
      const mask: MaskConfig = { mode: 'none', types: [], replacementMode: 'preview' };
      expect(ensureMaskCoversInterceptor(mask, { mode: 'all' })).toEqual({
        mode: 'custom',
        types: ['cloudAccessKey', 'apiKey', 'privateKey', 'databaseUrl'],
        replacementMode: 'preview',
      });
      expect(mask).toEqual({ mode: 'none', types: [], replacementMode: 'preview' });
    });

    it('merges custom mask types without duplicates or changing the source config', () => {
      const mask: MaskConfig = { mode: 'custom', types: ['email', 'apiKey', 'email'], replacementMode: 'preview' };
      expect(ensureMaskCoversInterceptor(mask, { mode: 'all' })).toEqual({
        mode: 'custom',
        types: ['email', 'apiKey', 'cloudAccessKey', 'privateKey', 'databaseUrl'],
        replacementMode: 'preview',
      });
      expect(mask.types).toEqual(['email', 'apiKey', 'email']);
    });

    it('leaves mask all unchanged when interception is enabled', () => {
      const mask: MaskConfig = { mode: 'all', types: [], replacementMode: 'preview' };
      expect(ensureMaskCoversInterceptor(mask, { mode: 'all' })).toBe(mask);
      expect(INTERCEPTOR_MASK_TYPES).toEqual(['cloudAccessKey', 'apiKey', 'privateKey', 'databaseUrl']);
    });
  });
});
