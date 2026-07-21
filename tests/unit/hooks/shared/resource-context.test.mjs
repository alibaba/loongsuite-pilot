import { describe, expect, test, vi } from 'vitest';

import {
  agentBaseFieldPatch,
  collectResourceAttributesFromEnv,
  parseSpanAttributesFromEnv,
} from '../../../../assets/hooks/shared/resource-context.mjs';

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
