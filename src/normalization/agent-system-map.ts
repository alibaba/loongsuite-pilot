export const AGENT_SYSTEM_MAP: Record<string, string> = {
  'claude-code': 'claude',
  'codex': 'codex',
  'codex-session': 'codex',
  'copilot': 'copilot',
  'qoder': 'qoder',
  'qoder-app': 'qoder-app',
  'qoder-cn': 'qoder',
  'qoder-idea': 'qoder',
  'qoder-work': 'qoder',
  'qoder-work-cn': 'qoder',
  'qwen-work-cn': 'qwen',
  'qoder-cli': 'qoder',
  'qoder-cli-hook': 'qoder',
  'cursor': 'cursor',
  'cursor-cli': 'cursor',
  'cursor-hook': 'cursor',
  'kiro-cli': 'kiro',
  'qwen-code-cli': 'qwen-code',
  'opencode': 'opencode',
  'openclaw': 'openclaw',
  'mimo-code': 'mimo-code',
  'pi-coding-agent': 'pi',
  'grok-build': 'grok',
  'hermes': 'hermes',
  'wukong': 'wukong',
  'workbuddy': 'workbuddy',
  'doubao-work': 'doubao',
  'dsh': 'dsh',
};

export function resolveAgentSystem(agentType: string): string {
  return AGENT_SYSTEM_MAP[agentType] ?? 'unknown';
}
