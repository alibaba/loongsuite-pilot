import { describe, expect, test } from 'vitest';
import { inferProvider } from '../../../../assets/hooks/qwen-code-cli/provider-inferrer.mjs';

describe('inferProvider', () => {
  describe('by model name', () => {
    test.each([
      ['qwen3.6-plus', 'qwen'],
      ['qwen3-coder-plus', 'qwen'],
      ['qwen-max-2025-01-25', 'qwen'],
      ['tongyi-qwen-plus', 'qwen'],
      ['claude-3-5-sonnet-20241022', 'anthropic'],
      ['claude-opus-4-7', 'anthropic'],
      ['gpt-4o', 'openai'],
      ['gpt-4-turbo', 'openai'],
      ['o1-preview', 'openai'],
      ['o3-mini', 'openai'],
      ['codex-mini', 'openai'],
      ['gemini-1.5-pro', 'gcp.gemini'],
      ['deepseek-r1', 'deepseek'],
      ['grok-2-latest', 'x_ai'],
    ])('model %s → %s', (model, expected) => {
      expect(inferProvider(model, undefined)).toBe(expected);
    });

    test('case insensitive', () => {
      expect(inferProvider('QWEN-MAX', undefined)).toBe('qwen');
      expect(inferProvider('Claude-Sonnet', undefined)).toBe('anthropic');
    });
  });

  describe('by auth_type when model is empty/unknown', () => {
    test('auth_type=openai → openai', () => {
      expect(inferProvider('', 'openai')).toBe('openai');
      expect(inferProvider(undefined, 'openai')).toBe('openai');
    });

    test('auth_type=anthropic → anthropic', () => {
      expect(inferProvider('', 'anthropic')).toBe('anthropic');
    });

    test('auth_type=qwen → qwen', () => {
      expect(inferProvider('', 'qwen')).toBe('qwen');
    });
  });

  describe('model takes precedence over auth_type', () => {
    // qwen-code is openai-API-compatible — auth_type may say "openai" even
    // when the actual model is qwen. The model name is the source of truth.
    test('qwen model + openai auth → qwen', () => {
      expect(inferProvider('qwen3.6-plus', 'openai')).toBe('qwen');
    });

    test('claude model + openai auth → anthropic', () => {
      expect(inferProvider('claude-3-5-sonnet', 'openai')).toBe('anthropic');
    });
  });

  describe('fallback', () => {
    test('no model, no auth_type → qwen (qwen-code default)', () => {
      expect(inferProvider(undefined, undefined)).toBe('qwen');
      expect(inferProvider('', '')).toBe('qwen');
    });

    test('unrecognized model + unrecognized auth → qwen', () => {
      expect(inferProvider('weird-model-xyz', 'some-auth')).toBe('qwen');
    });
  });
});
