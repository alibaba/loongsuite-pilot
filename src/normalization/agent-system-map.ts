export const AGENT_SYSTEM_MAP: Record<string, string> = {
  'claude-code': 'claude',
  'codex': 'codex',
  'codex-session': 'codex',
  'qoder': 'qoder',
  'qoder-idea': 'qoder',
  'qoder-work': 'qoder',
  'qoder-work-cn': 'qoder',
  'qwen-work-cn': 'qwen',
  'qoder-cli': 'qoder',
  'qoder-cli-hook': 'qoder',
  'cursor': 'cursor',
  'cursor-hook': 'cursor',
  'qwen-code-cli': 'qwen-code',
  'opencode': 'opencode',
  'mimo-code': 'mimo-code',
  'pi-coding-agent': 'pi',
  'grok-build': 'grok',
  'hermes': 'hermes',
  'wukong': 'wukong',
  'zcode': 'zcode',
  'zcode-hook': 'zcode',
  'zcode-rollout': 'zcode',
  'workbuddy': 'workbuddy',
  'dsh': 'dsh',
};

export function resolveAgentSystem(agentType: string): string {
  return AGENT_SYSTEM_MAP[agentType] ?? 'unknown';
}
