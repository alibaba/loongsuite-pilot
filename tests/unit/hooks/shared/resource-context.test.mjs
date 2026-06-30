import { describe, expect, test, vi } from 'vitest';

import {
  agentBaseFieldPatch,
  collectResourceAttributesFromEnv,
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
