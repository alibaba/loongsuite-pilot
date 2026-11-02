import { describe, expect, it } from 'vitest';
import { resolveAgentConfig } from '../../../src/normalization/agent-config.js';
import { enrichCanonicalEntryWithGit } from '../../../src/normalization/enrich-git-context.js';
import type { AgentActivityEntry, AgentsConfig } from '../../../src/types/index.js';

describe('Qoder app shared policies', () => {
  it('inherits Qoder multimodal configuration without losing product identity', () => {
    const entry = {
      'gen_ai.agent.type': 'qoder-app', 'gen_ai.framework': 'qoder-app',
    } as unknown as AgentActivityEntry;
    const config: AgentsConfig = { qoder: { multimodal: { uploadMode: 'input' } } };
    const resolved = resolveAgentConfig(entry, config);
    expect(resolved.agentId).toBe('qoder');
    expect(resolved.agentConfig).toEqual(config.qoder);
    expect(entry['gen_ai.agent.type']).toBe('qoder-app');
    expect(entry['gen_ai.framework']).toBe('qoder-app');
  });

  it('retains the Qoder cwd carrier for shared workspace attribution', async () => {
    const entry = { 'gen_ai.agent.type': 'qoder-app', 'agent.qoder.cwd': '/tmp/qoder-app-policy' };
    await enrichCanonicalEntryWithGit(entry, entry, 'qoder-app');
    expect(entry).toHaveProperty('workspace.path', '/tmp/qoder-app-policy');
  });
});
