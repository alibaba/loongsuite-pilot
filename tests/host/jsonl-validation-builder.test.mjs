// The optional remote-E2E driver remains JavaScript. Collector validation is
// exercised through the native xtask CLI, independently of this host tool.
import { describe, it, expect } from 'vitest';
import {
  buildJsonlValidationSh,
  JSONL_VALIDATOR_JS,
} from '../../scripts/e2e/lib/e2e-scenarios.mjs';

describe('remote E2E JSONL script builder', () => {
  it('returns empty string when E2E_JSONL_VALIDATE=0', () => {
    expect(buildJsonlValidationSh({ E2E_JSONL_VALIDATE: '0' })).toBe('');
  });
  it('embeds the existing validator and required remote controls', () => {
    const script = buildJsonlValidationSh({});
    expect(script).toContain('[jsonl-validate]');
    expect(script).toContain('base64 -d | node -');
    expect(script).toContain('E2E_JSONL_LOG_DIR');
    expect(script).toContain('E2E_JSONL_STRICT');
  });
  it('declares every original required activity field', () => {
    for (const key of [
      'time_unix_nano', 'event.id', 'user.id', 'event.name',
      'gen_ai.session.id', 'gen_ai.agent.type', 'gen_ai.provider.name',
    ]) expect(JSONL_VALIDATOR_JS).toContain(key);
  });
});
