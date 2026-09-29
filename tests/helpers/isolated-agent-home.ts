import * as os from 'node:os';
import * as path from 'node:path';
import type { MockedFunction } from 'vitest';

export function agentHomeEnvironment(homeDir: string): Record<string, string> {
  return {
    HOME: homeDir,
    USERPROFILE: homeDir,
    APPDATA: path.join(homeDir, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(homeDir, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(homeDir, '.config'),
    CLAUDE_CONFIG_DIR: path.join(homeDir, '.claude'),
    CODEX_HOME: path.join(homeDir, '.codex'),
    GROK_HOME: path.join(homeDir, '.grok'),
    HERMES_HOME: path.join(homeDir, '.hermes'),
    PI_CODING_AGENT_DIR: path.join(homeDir, '.pi', 'agent'),
    DSH_HOME: path.join(homeDir, '.dsh'),
    // Keep explicit test config paths usable instead of inheriting a live profile.
    OPENCLAW_CONFIG_PATH: '',
    OPENCLAW_STATE_DIR: '',
  };
}

/**
 * Keep deployment and migration inside a test's temporary directory.
 * Callers must mock node:os with a mutable homedir mock before importing code
 * under test: changing process.env.HOME alone does not change native homedir()
 * inside Vitest's worker threads.
 */
export function isolateAgentHome(homeDir: string): () => void {
  const env = agentHomeEnvironment(homeDir);
  const previousEnv = Object.entries(env).map(([key]) => [key, process.env[key]] as const);
  const homedir = os.homedir as MockedFunction<typeof os.homedir>;
  const previousHomedir = homedir.getMockImplementation();
  homedir.mockReturnValue(homeDir);
  for (const [key, value] of Object.entries(env)) process.env[key] = value;

  return () => {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (previousHomedir) homedir.mockImplementation(previousHomedir);
    else homedir.mockReset();
  };
}
