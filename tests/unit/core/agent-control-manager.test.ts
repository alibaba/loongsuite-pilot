import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { AgentControlManager } from '../../../src/core/agent-control-manager.js';
import { createTempDir, cleanupTempDir } from '../../helpers/fixture-builder.js';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

describe('AgentControlManager', () => {
  describe('resolveEnabled three-tier mode (T028)', () => {
    let manager: AgentControlManager;

    beforeEach(async () => {
      manager = new AgentControlManager('/tmp/nonexistent-control.json');
      await manager.load();
    });

    it('mode=on returns true regardless of defaultWhenAuto', () => {
      manager.setMode('agent-x', 'on');
      expect(manager.resolveEnabled('agent-x', false)).toBe(true);
      expect(manager.resolveEnabled('agent-x', true)).toBe(true);
    });

    it('mode=off returns false regardless of defaultWhenAuto', () => {
      manager.setMode('agent-x', 'off');
      expect(manager.resolveEnabled('agent-x', true)).toBe(false);
      expect(manager.resolveEnabled('agent-x', false)).toBe(false);
    });

    it('mode=auto returns defaultWhenAuto', () => {
      manager.setMode('agent-x', 'auto');
      expect(manager.resolveEnabled('agent-x', true)).toBe(true);
      expect(manager.resolveEnabled('agent-x', false)).toBe(false);
    });

    it('unset mode defaults to auto (returns defaultWhenAuto)', () => {
      expect(manager.resolveEnabled('unknown-agent', true)).toBe(true);
      expect(manager.resolveEnabled('unknown-agent', false)).toBe(false);
    });

    it('getMode returns auto for unset agents', () => {
      expect(manager.getMode('unknown')).toBe('auto');
    });

    it('getAllModes returns all set modes', () => {
      manager.setMode('a', 'on');
      manager.setMode('b', 'off');
      const modes = manager.getAllModes();
      expect(modes.a).toBe('on');
      expect(modes.b).toBe('off');
    });
  });

  describe('load/save persistence (T029)', () => {
    let tmpDir: string;
    let filePath: string;

    beforeEach(async () => {
      tmpDir = await createTempDir('acm-test-');
      filePath = path.join(tmpDir, 'agent-control.json');
    });

    afterEach(async () => {
      await cleanupTempDir(tmpDir);
    });

    it('persists mode changes through save/reload cycle', async () => {
      const mgr1 = new AgentControlManager(filePath);
      await mgr1.load();
      mgr1.setMode('agent-a', 'on');
      mgr1.setMode('agent-b', 'off');
      await mgr1.save();

      const mgr2 = new AgentControlManager(filePath);
      await mgr2.load();
      expect(mgr2.getMode('agent-a')).toBe('on');
      expect(mgr2.getMode('agent-b')).toBe('off');
      expect(mgr2.resolveEnabled('agent-a')).toBe(true);
      expect(mgr2.resolveEnabled('agent-b')).toBe(false);
    });

    it('loads empty config when file does not exist', async () => {
      const mgr = new AgentControlManager(path.join(tmpDir, 'nonexistent.json'));
      await mgr.load();
      expect(mgr.getAllModes()).toEqual({});
    });
  });
});
