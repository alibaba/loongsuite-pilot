import { describe, expect, test } from 'vitest';
import {
  hasModelToolSpanForOutput,
  isRuntimeSkillLoadSpan,
  unmatchedToolsForLlmOutput,
} from '../../scripts/validate-trace.mjs';

function tool(attributes) {
  return { spanId: attributes['gen_ai.tool.call.id'], attributes };
}

describe('semantic.tool_matches_llm_output runtime Skill handling', () => {
  test('extension TOOL with Skill attributes does not require an LLM output tool_call', () => {
    const runtimeSkill = tool({
      'gen_ai.tool.name': 'load_skill',
      'gen_ai.tool.type': 'extension',
      'gen_ai.tool.call.id': 'toolu_skillload_1',
      'gen_ai.skill.name': 'dws',
      'gen_ai.skill.id': 'dws',
    });

    expect(isRuntimeSkillLoadSpan(runtimeSkill)).toBe(true);
    expect(unmatchedToolsForLlmOutput([runtimeSkill], [])).toEqual([]);
    expect(hasModelToolSpanForOutput([runtimeSkill], {
      id: 'toolu_skillload_1',
      name: 'load_skill',
    })).toBe(false);
  });

  test('ordinary and model-triggered tools still require matching LLM output', () => {
    const ordinary = tool({
      'gen_ai.tool.name': 'Read',
      'gen_ai.tool.type': 'function',
      'gen_ai.tool.call.id': 'toolu_read_1',
    });
    const modelSkill = tool({
      'gen_ai.tool.name': 'Skill',
      'gen_ai.tool.type': 'function',
      'gen_ai.tool.call.id': 'toolu_skill_1',
      'gen_ai.skill.name': 'dws',
      'gen_ai.skill.id': 'dws',
    });

    expect(isRuntimeSkillLoadSpan(ordinary)).toBe(false);
    expect(isRuntimeSkillLoadSpan(modelSkill)).toBe(false);
    expect(unmatchedToolsForLlmOutput([ordinary, modelSkill], [])).toEqual([
      ordinary,
      modelSkill,
    ]);
    expect(unmatchedToolsForLlmOutput([ordinary, modelSkill], [
      { id: 'toolu_read_1', name: 'Read' },
      { id: 'toolu_skill_1', name: 'Skill' },
    ])).toEqual([]);
    expect(hasModelToolSpanForOutput([ordinary, modelSkill], {
      id: 'toolu_skill_1',
      name: 'Skill',
    })).toBe(true);
  });

  test('extension without Skill attributes is not exempted', () => {
    const extensionTool = tool({
      'gen_ai.tool.name': 'runtime_extension',
      'gen_ai.tool.type': 'extension',
      'gen_ai.tool.call.id': 'runtime_1',
    });

    expect(isRuntimeSkillLoadSpan(extensionTool)).toBe(false);
    expect(unmatchedToolsForLlmOutput([extensionTool], [])).toEqual([extensionTool]);
  });
});
