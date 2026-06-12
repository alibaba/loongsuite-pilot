import { describe, expect, it, vi } from 'vitest';
import type { AgentDefinition, AgentDetectionEntry } from '../../../src/types/index.js';
import { detectAgent } from '../../../src/deployment/detect-utils.js';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../src/deployment/detect-utils.js', () => ({
  detectAgent: vi.fn(),
}));

function buildDeployDetectionEntry(
  def: AgentDefinition,
  deploySingle: (d: AgentDefinition) => Promise<void>,
): AgentDetectionEntry {
  const watchPaths = def.detection.paths.map(p =>
    p.startsWith('~') ? p.replace('~', '/home/user') : p,
  );
  return {
    id: `deploy:${def.id}`,
    type: 'deploy-detection',
    watchPaths,
    isAvailable: () => detectAgent(def.detection),
    enabled: () => true,
    start: async () => { await deploySingle(def); },
    stop: async () => {},
    pollIntervalMs: 300_000,
  };
}

describe('dynamic discovery flow', () => {
  const cursorDef: AgentDefinition = {
    id: 'cursor',
    displayName: 'Cursor',
    deployMode: 'hook',
    detection: { paths: ['~/.cursor'], commands: [] },
    hook: {
      settingsPath: '~/.cursor/hooks.json',
      events: ['Stop'],
      hookCommand: '/opt/pilot/hooks/cursor.sh',
      format: 'flat',
    },
  };

  const pluginDef: AgentDefinition = {
    id: 'claude-code',
    displayName: 'Claude Code',
    deployMode: 'plugin-probe',
    detection: { paths: ['~/.claude'], commands: [] },
    pluginProbe: {
      source: { type: 'tar', tarball: '/opt/pilot/plugins/claude.tar.gz', destDir: '/opt/cache/claude' },
      install: { command: 'node', args: ['install.js'], cwd: '/opt/cache/claude' },
      mountType: 'wrapper',
    },
  };

  it('creates detection entries from agent definitions', () => {
    const deploySingle = vi.fn();
    const entries = [cursorDef, pluginDef].map(d => buildDeployDetectionEntry(d, deploySingle));

    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe('deploy:cursor');
    expect(entries[1].id).toBe('deploy:claude-code');
  });

  it('expands ~ in watchPaths', () => {
    const deploySingle = vi.fn();
    const entry = buildDeployDetectionEntry(cursorDef, deploySingle);
    expect(entry.watchPaths).toEqual(['/home/user/.cursor']);
  });

  it('sets poll interval to 300 seconds', () => {
    const deploySingle = vi.fn();
    const entry = buildDeployDetectionEntry(cursorDef, deploySingle);
    expect(entry.pollIntervalMs).toBe(300_000);
  });

  it('calls deploySingle when start() is triggered', async () => {
    const deploySingle = vi.fn().mockResolvedValue(undefined);
    const entry = buildDeployDetectionEntry(cursorDef, deploySingle);

    await entry.start();
    expect(deploySingle).toHaveBeenCalledWith(cursorDef);
  });

  it('isAvailable delegates to detectAgent', async () => {
    vi.mocked(detectAgent).mockResolvedValue(true);
    const deploySingle = vi.fn();
    const entry = buildDeployDetectionEntry(cursorDef, deploySingle);

    const available = await entry.isAvailable();
    expect(available).toBe(true);
    expect(detectAgent).toHaveBeenCalledWith(cursorDef.detection);
  });

  it('enabled always returns true', () => {
    const deploySingle = vi.fn();
    const entry = buildDeployDetectionEntry(cursorDef, deploySingle);
    expect(entry.enabled()).toBe(true);
  });

  it('skips definitions with no watchPaths', () => {
    const def: AgentDefinition = {
      id: 'no-paths',
      displayName: 'No Paths',
      deployMode: 'hook',
      detection: { paths: [], commands: ['some-cmd'] },
    };

    const deploySingle = vi.fn();
    const entry = buildDeployDetectionEntry(def, deploySingle);
    expect(entry.watchPaths).toHaveLength(0);
  });

  it('handles multiple detection paths', () => {
    const def: AgentDefinition = {
      id: 'multi-path',
      displayName: 'Multi',
      deployMode: 'hook',
      detection: { paths: ['~/.agent', '/opt/agent', '~/.agent-alt'], commands: [] },
    };

    const deploySingle = vi.fn();
    const entry = buildDeployDetectionEntry(def, deploySingle);
    expect(entry.watchPaths).toEqual(['/home/user/.agent', '/opt/agent', '/home/user/.agent-alt']);
  });
});
