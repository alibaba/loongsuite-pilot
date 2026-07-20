import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildJsonlValidationSh, JSONL_VALIDATOR_JS } from '../../scripts/e2e/lib/e2e-scenarios.mjs';

/** Run the embedded validator by piping its source into `node -` (mirrors how the remote bash runs it). */
function runValidator(envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  const r = spawnSync(process.execPath, ['-'], { env, input: JSONL_VALIDATOR_JS, encoding: 'utf8' });
  return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

describe('buildJsonlValidationSh', () => {
  it('returns empty string when E2E_JSONL_VALIDATE=0', () => {
    expect(buildJsonlValidationSh({ E2E_JSONL_VALIDATE: '0' })).toBe('');
  });

  it('embeds base64 validator and references AgentActivityEntry schema', () => {
    const sh = buildJsonlValidationSh({});
    expect(sh).toContain('[jsonl-validate]');
    expect(sh).toContain('base64 -d | node -');
    expect(sh).toContain('E2E_JSONL_LOG_DIR');
    expect(sh).toContain('E2E_JSONL_STRICT');
  });

  it('validator source declares all REQUIRED AgentActivityEntry fields', () => {
    for (const key of [
      'time_unix_nano', 'event.id', 'user.id', 'event.name',
      'gen_ai.session.id', 'gen_ai.agent.type', 'gen_ai.provider.name',
    ]) {
      expect(JSONL_VALIDATOR_JS).toContain(key);
    }
  });
});

describe('JSONL_VALIDATOR_JS (integration)', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-validate-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeJsonl(name, entries) {
    fs.writeFileSync(path.join(tmpDir, name), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  }

  const goodEntry = (overrides = {}) => ({
    time_unix_nano: String(BigInt(Date.now()) * 1000000n),
    'event.id': 'evt-1',
    'user.id': 'u-1',
    'event.name': 'llm.request',
    'gen_ai.session.id': 'sess-1',
    'gen_ai.agent.type': 'claude',
    'gen_ai.provider.name': 'anthropic',
    ...overrides,
  });

  it('passes cleanly on valid entries', () => {
    writeJsonl('claude-code-2026-05-11.jsonl', [goodEntry(), goodEntry({ 'event.id': 'evt-2' })]);
    const r = runValidator({ _JV_LOG_DIR: tmpDir, E2E_JSONL_STRICT: '1' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('OK claude-code-2026-05-11.jsonl');
    expect(r.out).toContain('missing_required=0');
  });

  it('detects missing required fields and exits 1 under STRICT', () => {
    writeJsonl('codex-2026-05-11.jsonl', [
      goodEntry(),
      { ...goodEntry(), 'user.id': undefined },
    ]);
    const r = runValidator({ _JV_LOG_DIR: tmpDir, E2E_JSONL_STRICT: '1' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL codex-2026-05-11.jsonl');
    expect(r.out).toMatch(/missing=\[.*user\.id.*\]/);
  });

  it('honors E2E_JSONL_AGENT_FILTER', () => {
    writeJsonl('claude-2026-05-11.jsonl', [goodEntry()]);
    writeJsonl('codex-2026-05-11.jsonl', [{ ...goodEntry(), 'event.name': undefined }]);
    const r = runValidator({
      _JV_LOG_DIR: tmpDir,
      E2E_JSONL_AGENT_FILTER: 'claude',
      E2E_JSONL_STRICT: '1',
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain('claude-2026-05-11.jsonl');
    expect(r.out).not.toContain('codex-2026-05-11.jsonl');
  });

  it('reports bad event.name enum values', () => {
    writeJsonl('claude-code-2026-05-11.jsonl', [goodEntry({ 'event.name': 'not.a.real.event' })]);
    const r = runValidator({ _JV_LOG_DIR: tmpDir, E2E_JSONL_STRICT: '1' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('bad_event_name=1');
  });

  it('returns 0 with hint when log dir is empty (non-strict)', () => {
    const r = runValidator({ _JV_LOG_DIR: tmpDir });
    expect(r.code).toBe(0);
    expect(r.out).toContain('no .jsonl files');
  });

  it('default filter covers the L1 CLI coverage set and excludes IDE-only agents', () => {
    writeJsonl('claude-code-2026-05-11.jsonl', [goodEntry()]);
    writeJsonl('codex-2026-05-11.jsonl', [goodEntry()]);
    writeJsonl('qoder-cli-2026-05-11.jsonl', [goodEntry({ 'gen_ai.agent.type': 'qoder-cli' })]);
    writeJsonl('cursor-cli-2026-05-11.jsonl', [goodEntry({ 'gen_ai.agent.type': 'cursor-cli' })]);
    writeJsonl('qwen-code-cli-2026-05-11.jsonl', [goodEntry({ 'gen_ai.agent.type': 'qwen-code-cli' })]);
    writeJsonl('opencode-2026-05-11.jsonl', [goodEntry({ 'gen_ai.agent.type': 'opencode' })]);
    writeJsonl('qoder-2026-05-11.jsonl', [goodEntry()]);
    const r = runValidator({ _JV_LOG_DIR: tmpDir, E2E_JSONL_STRICT: '1' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('claude-code-2026-05-11.jsonl');
    expect(r.out).toContain('codex-2026-05-11.jsonl');
    expect(r.out).toContain('qoder-cli-2026-05-11.jsonl');
    expect(r.out).toContain('cursor-cli-2026-05-11.jsonl');
    expect(r.out).toContain('qwen-code-cli-2026-05-11.jsonl');
    expect(r.out).toContain('opencode-2026-05-11.jsonl');
    expect(r.out).not.toContain('qoder-2026-05-11.jsonl');
  });

  it('E2E_JSONL_AGENT_FILTER=all disables filtering', () => {
    writeJsonl('cursor-2026-05-11.jsonl', [goodEntry()]);
    const r = runValidator({ _JV_LOG_DIR: tmpDir, E2E_JSONL_AGENT_FILTER: 'all', E2E_JSONL_STRICT: '1' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('cursor-2026-05-11.jsonl');
  });
});
