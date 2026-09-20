/**
 * Official Agent home-directory overrides, used as `$NAME` placeholders in
 * agents.d definitions. Unset/blank → the documented default; set → used
 * verbatim (no extra suffix). Workspace-directory variables such as
 * `GROK_WORKSPACE_DIR` and `DSH_WORKSPACE_DIR` are not homes and must not be
 * substituted here.
 */
export const DEFAULT_PI_CODING_AGENT_DIR = '~/.pi/agent';
export const DEFAULT_GROK_HOME = '~/.grok';
export const DEFAULT_DSH_HOME = '~/.dsh';

function envDir(name: string, fallback: string, env: NodeJS.ProcessEnv): string {
  const raw = (env[name] ?? '').trim();
  return raw || fallback;
}

export function resolvePiCodingAgentDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return envDir('PI_CODING_AGENT_DIR', DEFAULT_PI_CODING_AGENT_DIR, env);
}

export function resolveGrokHome(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return envDir('GROK_HOME', DEFAULT_GROK_HOME, env);
}

export function resolveDshHome(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return envDir('DSH_HOME', DEFAULT_DSH_HOME, env);
}
