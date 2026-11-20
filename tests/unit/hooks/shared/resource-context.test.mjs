import { describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_RESOURCE_ENV_FIELD_MAP,
  INVOCATION_SESSION_ID_FIELD,
  INVOCATION_USER_ID_FIELD,
  agentBaseFieldPatch,
  collectResourceAttributesFromEnv,
  parseSpanAttributesFromEnv,
} from '../../../../assets/hooks/shared/resource-context.mjs';
import {
  DEFAULT_RESOURCE_ENV_FIELD_MAP as PLUGIN_RESOURCE_ENV_FIELD_MAP,
  agentBaseFieldPatch as pluginAgentBaseFieldPatch,
  collectResourceAttributesFromEnv as collectPluginResourceAttributesFromEnv,
} from '../../../../assets/plugins/shared/resource-context.mjs';

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

  test('hook and plugin helpers keep the same resource context contract', () => {
    expect(PLUGIN_RESOURCE_ENV_FIELD_MAP).toEqual(DEFAULT_RESOURCE_ENV_FIELD_MAP);

    const env = {
      AGENTTEAMS_WORKER_NAME: ' planner ',
      AGENTTEAMS_INSTANCE_ID: ' instance-01 ',
      AGENTTEAMS_TOKEN: 'must-not-leak',
      AGENTTEAMS_TEAM_NAME: 'not-allowlisted',
    };
    const hookAttributes = collectResourceAttributesFromEnv(env);
    const pluginAttributes = collectPluginResourceAttributesFromEnv(env);

    expect(pluginAttributes).toEqual(hookAttributes);
    expect(pluginAgentBaseFieldPatch(pluginAttributes)).toEqual(
      agentBaseFieldPatch(hookAttributes),
    );
    expect(JSON.stringify(pluginAttributes)).not.toContain('must-not-leak');
  });

  test('hook and plugin helpers both reject empty and over-long values', () => {
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const env = {
        AGENTTEAMS_WORKER_NAME: ' ',
        AGENTTEAMS_INSTANCE_ID: 'x'.repeat(513),
      };
      expect(collectResourceAttributesFromEnv(env)).toEqual({});
      expect(collectPluginResourceAttributesFromEnv(env)).toEqual({});
    } finally {
      warn.mockRestore();
    }
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

  test('accepts only the two managed identity keys when explicitly enabled', () => {
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const attrs = parseSpanAttributesFromEnv({
        LOONGSUITE_PILOT_SPAN_ATTRIBUTES: [
          'gen_ai.session.id=customer-session',
          'gen_ai.user.id=customer-user',
          'gen_ai.agent.name=must-stay-reserved',
          'user.id=must-stay-reserved',
          'multica.issue.id=AGE-287',
        ].join(','),
      }, { allowInvocationIdentity: true });

      expect(attrs).toEqual({
        [INVOCATION_SESSION_ID_FIELD]: 'customer-session',
        [INVOCATION_USER_ID_FIELD]: 'customer-user',
        'multica.issue.id': 'AGE-287',
      });
      expect(JSON.stringify(attrs)).not.toContain('must-stay-reserved');
    } finally {
      warn.mockRestore();
    }
  });

  test('keeps managed identity keys reserved without explicit opt-in', () => {
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(parseSpanAttributesFromEnv({
        LOONGSUITE_PILOT_SPAN_ATTRIBUTES:
          'gen_ai.session.id=customer-session,gen_ai.user.id=customer-user',
      })).toEqual({});
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
  // The reserved-prefix list is intentionally duplicated in four places
  // (shared hook util, standalone plugins, and the TS normalizer).
  // This guards against silent drift between them.
  test('shared mjs, opencode plugin, and global-attributes.ts agree', () => {
    const canonical = extractPrefixArray('src/normalization/global-attributes.ts', 'RESERVED_PREFIXES');
    const sharedHook = extractPrefixArray('assets/hooks/shared/resource-context.mjs', 'SPAN_ATTR_RESERVED_PREFIXES');
    const opencode = extractPrefixArray('assets/plugins/opencode/plugin.mjs', 'SPAN_ATTR_RESERVED_PREFIXES');
    const openclaw = extractPrefixArray('assets/plugins/openclaw/plugin.mjs', 'SPAN_ATTR_RESERVED_PREFIXES');

    expect(canonical.length).toBeGreaterThan(0);
    expect(sharedHook).toEqual(canonical);
    expect(opencode).toEqual(canonical);
    expect(openclaw).toEqual(canonical);
  });
});
