import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentActivityEntry } from '../../src/types/index.js';
import { ClientType } from '../../src/types/index.js';
import { QoderWorkSqliteInput } from '../../src/inputs/qoder-work-sqlite/qoder-work-sqlite-input.js';
import { QwenWorkCNSqliteInput } from '../../src/inputs/qwen-work-cn/qwen-work-cn-sqlite-input.js';
import { MockStateStore } from '../helpers/mock-state-store.js';

const QWEN_WORK_CN_DB = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'QwenWorkCN',
  'data',
  'agents.db',
);

class CompatibilityProbe extends QoderWorkSqliteInput {
  async collectExistingRows(): Promise<AgentActivityEntry[]> {
    return this.collect();
  }
}

class IndependentProbe extends QwenWorkCNSqliteInput {
  async collectExistingRows(): Promise<AgentActivityEntry[]> {
    return this.collect();
  }
}

describe.skipIf(!existsSync(QWEN_WORK_CN_DB))(
  'QwenWorkCN compatibility with the QoderWork SQLite collector',
  () => {
    it('reads real QwenWorkCN rows and maps them to canonical gen_ai fields', async () => {
      const stateStore = new MockStateStore();
      stateStore.update('qoder-work-cn-sqlite', {
        extra: { lastUpdatedAt: 0 },
      });
      const input = new CompatibilityProbe({
        stateStore: stateStore as never,
        agentType: ClientType.QoderWorkCN,
        dbPath: QWEN_WORK_CN_DB,
      });

      const entries = await input.collectExistingRows();

      expect(entries.length).toBeGreaterThan(0);
      expect(entries.some(entry => entry['event.name'] === 'llm.request')).toBe(true);
      for (const entry of entries) {
        expect(entry['event.id']).toEqual(expect.any(String));
        expect(entry.time_unix_nano).toMatch(/^\d+$/);
        expect(entry['gen_ai.agent.type']).toBe(ClientType.QoderWorkCN);
        expect(entry['gen_ai.session.id']).toEqual(expect.any(String));
        expect(entry['gen_ai.request.model']).toEqual(expect.any(String));
      }

      const request = entries.find(entry => entry['event.name'] === 'llm.request');
      expect(request?.['gen_ai.input.messages_delta']).toEqual([
        expect.objectContaining({ role: 'user' }),
      ]);
    });

    it('keeps the same field semantics in the independent QwenWorkCN collector', async () => {
      const compatibilityState = new MockStateStore();
      compatibilityState.update('qoder-work-cn-sqlite', { extra: { lastUpdatedAt: 0 } });
      const compatibility = new CompatibilityProbe({
        stateStore: compatibilityState as never,
        agentType: ClientType.QoderWorkCN,
        dbPath: QWEN_WORK_CN_DB,
      });
      const independentState = new MockStateStore();
      independentState.update('qwen-work-cn-sqlite', { extra: { lastUpdatedAt: 0 } });
      const independent = new IndependentProbe({
        stateStore: independentState as never,
        dbPath: QWEN_WORK_CN_DB,
      });

      const [compatibilityEntries, independentEntries] = await Promise.all([
        compatibility.collectExistingRows(),
        independent.collectExistingRows(),
      ]);

      expect(independentEntries.map(entry => entry['event.name']))
        .toEqual(compatibilityEntries.map(entry => entry['event.name']));
      const oldRequest = compatibilityEntries.find(entry => entry['event.name'] === 'llm.request');
      const newRequest = independentEntries.find(entry => entry['event.name'] === 'llm.request');
      expect(newRequest?.['gen_ai.input.messages_delta']).toEqual(oldRequest?.['gen_ai.input.messages_delta']);
      expect(newRequest?.['gen_ai.session.id']).toBe(oldRequest?.['gen_ai.session.id']);
      expect(newRequest?.['gen_ai.request.model']).toBe(oldRequest?.['gen_ai.request.model']);
      expect(newRequest?.['gen_ai.agent.type']).toBe(ClientType.QwenWorkCN);
      expect(newRequest?.['agent.source']).toBe('qwen-work-cn-sqlite');
    });
  },
);
