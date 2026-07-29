import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { detectSkillFromTranscript } from '../../../../assets/hooks/cursor/skill-detector.mjs';

function createTempTranscript(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-detector-test-'));
  const filePath = path.join(dir, 'transcript.jsonl');
  const content = lines.map(l => JSON.stringify(l)).join('\n');
  fs.writeFileSync(filePath, content, 'utf-8');
  return { dir, filePath };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('detectSkillFromTranscript', () => {
  let tempDir;
  let transcriptPath;

  afterEach(() => {
    if (tempDir) {
      cleanup(tempDir);
      tempDir = null;
    }
  });

  it('should detect skill usage when transcript contains Read SKILL.md', () => {
    const lines = [
      { role: 'user', message: { content: [{ type: 'text', text: '<timestamp>Tuesday, Jul 21, 2026, 1:35 PM (UTC+8)</timestamp>\n<user_query>\n使用 leetcode-solver，解决 leetcode 120\n</user_query>' }] } },
      { role: 'assistant', message: { content: [
        { type: 'text', text: 'I will read the skill file first.' },
        { type: 'tool_use', name: 'Read', input: { path: '/Users/yunshen/.cursor/skills/leetcode-solver/SKILL.md' } },
      ] } },
      { type: 'turn_ended' },
    ];

    ({ dir: tempDir, filePath: transcriptPath } = createTempTranscript(lines));

    const result = detectSkillFromTranscript(transcriptPath, '使用 leetcode-solver，解决 leetcode 120');
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result[0].skillName).toBe('leetcode-solver');
    expect(result[0].skillPath).toBe('/Users/yunshen/.cursor/skills/leetcode-solver/SKILL.md');
    expect(result[0].detectionSource).toBe('transcript_read');
    expect(result[0].detectionSources).toEqual(['transcript_read']);
  });

  it('should detect a manually attached skill without a Read tool call', () => {
    const lines = [
      { role: 'user', message: { content: [{ type: 'text', text: [
        '<manually_attached_skills>',
        'The user has manually attached the following skills to their message.',
        '',
        'Skill Name: count-if-statements',
        'Path: /Users/test/.cursor/skills/count-if-statements/SKILL.md',
        'SKILL.md content:',
        '# Count If Statements',
        '',
        'The full content is inlined but must not be emitted.',
        '</manually_attached_skills>',
        '<timestamp>Friday, Jul 24, 2026, 4:23 PM (UTC+8)</timestamp>',
        '<user_query>',
        '/count-if-statements 统计leetcode_334的if数量',
        '</user_query>',
      ].join('\n') }] } },
      { role: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Shell', input: {
          command: 'python3 ~/.cursor/skills/count-if-statements/scripts/count_if.py leetcode_334.py',
        } },
      ] } },
      { type: 'turn_ended' },
    ];

    ({ dir: tempDir, filePath: transcriptPath } = createTempTranscript(lines));

    const result = detectSkillFromTranscript(
      transcriptPath,
      '/count-if-statements 统计leetcode_334的if数量',
    );
    expect(result).toEqual([{
      skillName: 'count-if-statements',
      skillPath: '/Users/test/.cursor/skills/count-if-statements/SKILL.md',
      detectionSource: 'manual_attachment',
      detectionSources: ['manual_attachment'],
    }]);
  });

  it('should prefer the explicit user_query when inlined skill content contains another prompt', () => {
    const lines = [
      { role: 'user', message: { content: [{ type: 'text', text: [
        '<manually_attached_skills>',
        'Skill Name: prompt-helper',
        'Path: /Users/test/.cursor/skills/prompt-helper/SKILL.md',
        'SKILL.md content:',
        'fix the bug',
        '</manually_attached_skills>',
        '<user_query>',
        'run the attached helper',
        '</user_query>',
      ].join('\n') }] } },
      { type: 'turn_ended' },
    ];

    ({ dir: tempDir, filePath: transcriptPath } = createTempTranscript(lines));

    expect(detectSkillFromTranscript(transcriptPath, 'fix the bug')).toBeNull();
    expect(detectSkillFromTranscript(transcriptPath, 'run the attached helper')).toHaveLength(1);
  });

  it('should deduplicate manual attachment and Read evidence for the same skill', () => {
    const lines = [
      { role: 'user', message: { content: [{ type: 'text', text: [
        '<manually_attached_skills>',
        'Skill Name: my-skill',
        'Path: /Users/test/.cursor/skills/my-skill/SKILL.md',
        'SKILL.md content:',
        '# My Skill',
        '</manually_attached_skills>',
        '<user_query>',
        'use my skill',
        '</user_query>',
      ].join('\n') }] } },
      { role: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Read', input: {
          path: '/Users/test/.cursor/skills/my-skill/SKILL.md',
        } },
      ] } },
      { type: 'turn_ended' },
    ];

    ({ dir: tempDir, filePath: transcriptPath } = createTempTranscript(lines));

    const result = detectSkillFromTranscript(transcriptPath, 'use my skill');
    expect(result).toHaveLength(1);
    expect(result[0].detectionSource).toBe('manual_attachment');
    expect(result[0].detectionSources).toEqual(['manual_attachment', 'transcript_read']);
  });

  it('should detect multiple manually attached skills in one turn', () => {
    const lines = [
      { role: 'user', message: { content: [{ type: 'text', text: [
        '<manually_attached_skills>',
        'Skill Name: skill-a',
        'Path: /Users/test/.cursor/skills/skill-a/SKILL.md',
        'SKILL.md content:',
        '# Skill A',
        '',
        'Skill Name: skill-b',
        'Path: /Users/test/.cursor/skills/skill-b/SKILL.md',
        'SKILL.md content:',
        '# Skill B',
        '</manually_attached_skills>',
        '<user_query>',
        'use both attached skills',
        '</user_query>',
      ].join('\n') }] } },
      { type: 'turn_ended' },
    ];

    ({ dir: tempDir, filePath: transcriptPath } = createTempTranscript(lines));

    const result = detectSkillFromTranscript(transcriptPath, 'use both attached skills');
    expect(result.map(skill => skill.skillName)).toEqual(['skill-a', 'skill-b']);
    expect(result.every(skill => skill.detectionSource === 'manual_attachment')).toBe(true);
  });

  it('should choose the latest turn when identical prompts are repeated', () => {
    const makeUser = skillName => ({
      role: 'user',
      message: { content: [{ type: 'text', text: [
        '<manually_attached_skills>',
        `Skill Name: ${skillName}`,
        `Path: /Users/test/.cursor/skills/${skillName}/SKILL.md`,
        'SKILL.md content:',
        `# ${skillName}`,
        '</manually_attached_skills>',
        '<user_query>',
        'repeat this prompt',
        '</user_query>',
      ].join('\n') }] },
    });
    const lines = [
      makeUser('old-skill'),
      { type: 'turn_ended' },
      makeUser('new-skill'),
      { type: 'turn_ended' },
    ];

    ({ dir: tempDir, filePath: transcriptPath } = createTempTranscript(lines));

    const result = detectSkillFromTranscript(transcriptPath, 'repeat this prompt');
    expect(result.map(skill => skill.skillName)).toEqual(['new-skill']);
  });

  it('should return null when transcript has no skill reads', () => {
    const lines = [
      { role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nfix the bug\n</user_query>' }] } },
      { role: 'assistant', message: { content: [
        { type: 'text', text: 'Let me look at the code.' },
        { type: 'tool_use', name: 'Read', input: { path: '/Users/yunshen/project/src/main.ts' } },
      ] } },
      { type: 'turn_ended' },
    ];

    ({ dir: tempDir, filePath: transcriptPath } = createTempTranscript(lines));

    const result = detectSkillFromTranscript(transcriptPath, 'fix the bug');
    expect(result).toBeNull();
  });

  it('should match the correct turn among multiple turns', () => {
    const lines = [
      // Turn 1
      { role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nfirst turn prompt\n</user_query>' }] } },
      { role: 'assistant', message: { content: [
        { type: 'text', text: 'Done with first turn.' },
      ] } },
      { type: 'turn_ended' },
      // Turn 2 — with skill usage
      { role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nuse my-skill to do something\n</user_query>' }] } },
      { role: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Read', input: { path: '/home/user/.cursor/skills/my-skill/SKILL.md' } },
        { type: 'text', text: 'Skill loaded.' },
      ] } },
      { type: 'turn_ended' },
    ];

    ({ dir: tempDir, filePath: transcriptPath } = createTempTranscript(lines));

    const result = detectSkillFromTranscript(transcriptPath, 'use my-skill to do something');
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result[0].skillName).toBe('my-skill');
  });

  it('should match user prompt containing Chinese characters', () => {
    const lines = [
      { role: 'user', message: { content: [{ type: 'text', text: '<timestamp>2026-07-21</timestamp>\n<user_query>\n请使用代码审查技能检查代码\n</user_query>' }] } },
      { role: 'assistant', message: { content: [
        { type: 'tool_use', name: 'ReadFile', input: { path: 'C:\\Users\\test\\.cursor\\skills\\code-review\\SKILL.md' } },
      ] } },
      { type: 'turn_ended' },
    ];

    ({ dir: tempDir, filePath: transcriptPath } = createTempTranscript(lines));

    const result = detectSkillFromTranscript(transcriptPath, '请使用代码审查技能检查代码');
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result[0].skillName).toBe('code-review');
    expect(result[0].skillPath).toBe('C:\\Users\\test\\.cursor\\skills\\code-review\\SKILL.md');
  });

  it('should return null when path is not under .cursor/skills/', () => {
    const lines = [
      { role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nread some file\n</user_query>' }] } },
      { role: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Read', input: { path: '/Users/test/projects/skills/my-skill/SKILL.md' } },
      ] } },
      { type: 'turn_ended' },
    ];

    ({ dir: tempDir, filePath: transcriptPath } = createTempTranscript(lines));

    const result = detectSkillFromTranscript(transcriptPath, 'read some file');
    expect(result).toBeNull();
  });

  it('should return null when transcriptPath is empty or null', () => {
    expect(detectSkillFromTranscript(null, 'some prompt')).toBeNull();
    expect(detectSkillFromTranscript('', 'some prompt')).toBeNull();
  });

  it('should return null when userPrompt is empty or null', () => {
    const lines = [
      { role: 'user', message: { content: [{ type: 'text', text: 'hello' }] } },
    ];
    ({ dir: tempDir, filePath: transcriptPath } = createTempTranscript(lines));

    expect(detectSkillFromTranscript(transcriptPath, null)).toBeNull();
    expect(detectSkillFromTranscript(transcriptPath, '')).toBeNull();
  });

  it('should return null when transcript file does not exist', () => {
    const result = detectSkillFromTranscript('/nonexistent/path/transcript.jsonl', 'hello');
    expect(result).toBeNull();
  });

  it('should detect multiple skills in a single turn', () => {
    const lines = [
      { role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nuse both skills\n</user_query>' }] } },
      { role: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Read', input: { path: '/Users/test/.cursor/skills/skill-a/SKILL.md' } },
        { type: 'tool_use', name: 'Read', input: { path: '/Users/test/.cursor/skills/skill-b/SKILL.md' } },
      ] } },
      { type: 'turn_ended' },
    ];

    ({ dir: tempDir, filePath: transcriptPath } = createTempTranscript(lines));

    const result = detectSkillFromTranscript(transcriptPath, 'use both skills');
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result[0].skillName).toBe('skill-a');
    expect(result[1].skillName).toBe('skill-b');
  });

  it('should stop scanning at turn_ended boundary', () => {
    const lines = [
      { role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nfirst turn\n</user_query>' }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
      { type: 'turn_ended' },
      // Next turn has skill usage but should not be included
      { role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nsecond turn\n</user_query>' }] } },
      { role: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Read', input: { path: '/Users/test/.cursor/skills/some-skill/SKILL.md' } },
      ] } },
      { type: 'turn_ended' },
    ];

    ({ dir: tempDir, filePath: transcriptPath } = createTempTranscript(lines));

    const result = detectSkillFromTranscript(transcriptPath, 'first turn');
    expect(result).toBeNull();
  });
});
