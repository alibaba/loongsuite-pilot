export const AGENT_SYSTEM_MAP: Record<string, string> = {
  'claude-code': 'claude',
  'codex': 'codex',
  'codex-session': 'codex',
  'qoder': 'qoder',
  'qoder-idea': 'qoder',
  'qoder-work': 'qoder',
  'qoder-work-cn': 'qoder',
  'qoder-cli': 'qoder',
  'qoder-cli-hook': 'qoder',
  'cursor': 'cursor',
  'cursor-hook': 'cursor',
  'qwen-code-cli': 'qwen-code',
};

export function resolveAgentSystem(agentType: string): string {
  return AGENT_SYSTEM_MAP[agentType] ?? 'unknown';
}
