import type {
  EvaluateHookResponse,
  HookRequest,
  LocalRule,
} from '../types.js';

export class RuleEngine {
  constructor(
    private readonly rules: readonly LocalRule[],
    private readonly enabledRuleIds: ReadonlySet<string>,
  ) {}

  async evaluate(request: HookRequest): Promise<EvaluateHookResponse> {
    const evaluatedRules: string[] = [];
    for (const rule of this.rules) {
      if (!this.enabledRuleIds.has(rule.id)) continue;
      if (!rule.supports(request)) continue;
      evaluatedRules.push(rule.id);
      let result;
      try {
        result = await rule.evaluate(request);
      } catch {
        return { action: 'allow', evaluatedRules };
      }
      if (result.matched) {
        return {
          action: 'block',
          reason: result.reason,
          ruleId: rule.id,
          evaluatedRules,
        };
      }
    }
    return { action: 'allow', evaluatedRules };
  }
}
