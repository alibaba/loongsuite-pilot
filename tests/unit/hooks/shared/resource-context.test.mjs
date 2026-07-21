import { describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  agentBaseFieldPatch,
  collectResourceAttributesFromEnv,
  parseSpanAttributesFromEnv,
} from '../../../../assets/hooks/shared/resource-context.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../../../..');

/** Extract the string entries of a `NAME = [ ... ]` array literal from a source file. */
function extractPrefixArray(relPath, constName) {
  const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  const m = new RegExp(`${constName}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(src);
  if (!m) throw new Error(`${constName} not found in ${relPath}`);
  return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]).sort();
}

describe('hook resource context helper', () => {
  test('collects only default fixed non-sensitive resource marker fields', () => {
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      const fields = collectResourceAttributesFromEnv({
        AGENTTEAMS_WORKER_NAME: ' worker-01 ',
        AGENTTEAMS_INSTANCE_ID: ' example-instance ',
        AGENTTEAMS_TOKEN: 'should-not-leak',
        AGENTTEAMS_TEAM_NAME: 'not-in-fixed-map',
      }, { agentId: 'test-agent' });

      expect(fields).toEqual({
        'agentteams.worker.name': 'worker-01',
        'agentteams.instance.id': 'example-instance',
      });
      expect(JSON.stringify(fields)).not.toContain('should-not-leak');
      expect(JSON.stringify(fields)).not.toContain('not-in-fixed-map');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test('builds gen_ai.agent.name from worker name', () => {
    expect(agentBaseFieldPatch({
      'agentteams.worker.name': 'worker-01',
    })).toEqual({
      'gen_ai.agent.name': 'worker-01',
    });
  });
});

describe('parseSpanAttributesFromEnv', () => {
  test('parses key=value pairs and trims', () => {
    const attrs = parseSpanAttributesFromEnv({
      LOONGSUITE_PILOT_SPAN_ATTRIBUTES: 'multica.issue.id=AGE-992, multica.user.id = staff ',
    });
    expect(attrs).toEqual({
      'multica.issue.id': 'AGE-992',
      'multica.user.id': 'staff',
    });
  });

  test('returns empty for missing or empty env', () => {
    expect(parseSpanAttributesFromEnv({})).toEqual({});
    expect(parseSpanAttributesFromEnv({ LOONGSUITE_PILOT_SPAN_ATTRIBUTES: '' })).toEqual({});
  });

  test('drops reserved-prefix keys', () => {
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const attrs = parseSpanAttributesFromEnv({
        LOONGSUITE_PILOT_SPAN_ATTRIBUTES:
          'gen_ai.foo=x,git.repo=y,user.id=z,agent.thing=w,multica.ok=keep',
      });
      expect(attrs).toEqual({ 'multica.ok': 'keep' });
    } finally {
      warn.mockRestore();
    }
  });

  test('drops sensitive names, over-long values, and malformed pairs', () => {
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const long = 'v'.repeat(513);
      const attrs = parseSpanAttributesFromEnv({
        LOONGSUITE_PILOT_SPAN_ATTRIBUTES:
          `multica.token=secret,multica.big=${long},noequalssign,=novalue,multica.ok=keep`,
      });
      expect(attrs).toEqual({ 'multica.ok': 'keep' });
    } finally {
      warn.mockRestore();
    }
  });

  test('honors a custom envName', () => {
    const attrs = parseSpanAttributesFromEnv(
      { CUSTOM_ENV: 'multica.issue.id=AGE-1' },
      { envName: 'CUSTOM_ENV' },
    );
    expect(attrs).toEqual({ 'multica.issue.id': 'AGE-1' });
  });
});

describe('reserved-prefix list stays in sync across copies', () => {
  // The reserved-prefix list is intentionally duplicated in three places
  // (shared hook util, standalone opencode plugin, and the TS normalizer).
  // This guards against silent drift between them.
  test('shared mjs, opencode plugin, and global-attributes.ts agree', () => {
    const canonical = extractPrefixArray('src/normalization/global-attributes.ts', 'RESERVED_PREFIXES');
    const sharedHook = extractPrefixArray('assets/hooks/shared/resource-context.mjs', 'SPAN_ATTR_RESERVED_PREFIXES');
    const opencode = extractPrefixArray('assets/plugins/opencode/plugin.mjs', 'SPAN_ATTR_RESERVED_PREFIXES');

    expect(canonical.length).toBeGreaterThan(0);
    expect(sharedHook).toEqual(canonical);
    expect(opencode).toEqual(canonical);
  });
});
